'use strict';

const FEED_POLL_INTERVAL_MS = parseInt(process.env.FEED_POLL_INTERVAL_MS ?? '120000', 10); // 2 min
const MAX_INDEXED_CONTAINERS_PER_SOURCE = parseInt(process.env.MAX_INDEXED_CONTAINERS_PER_SOURCE ?? '14', 10);
const MAX_CONTAINERS_PER_FALLBACK_WALK = parseInt(process.env.MAX_CONTAINERS_PER_FALLBACK_WALK ?? '30', 10);
const SNAP_CONTAINER_AUTHOR = process.env.SNAP_CONTAINER_AUTHOR ?? 'peak.snaps';
const WAVE_CONTAINER_AUTHOR = process.env.WAVE_CONTAINER_AUTHOR ?? 'ecency.waves';
const FEED_PAGE_LIMIT_DEFAULT = 20;
const FEED_PAGE_LIMIT_MAX = 50;

const SOURCES = [
  { key: 'snap', author: SNAP_CONTAINER_AUTHOR },
  { key: 'wave', author: WAVE_CONTAINER_AUTHOR },
];

// Hive/hived timestamps omit the trailing 'Z' — without appending it,
// Date.parse/new Date() treat the string as local time. Same gotcha as
// poller.js's block timestamps.
function toIso(raw) {
  if (!raw) return null;
  const withZ = raw.endsWith('Z') ? raw : `${raw}Z`;
  return new Date(withZ).toISOString();
}

function buildPointerRecords(sourceKey, containerAuthor, containerPermlink, rawReplies) {
  if (!Array.isArray(rawReplies)) return [];
  return rawReplies
    .filter(r => r && typeof r.author === 'string' && typeof r.permlink === 'string')
    .map(r => ({
      source: sourceKey,
      author: r.author,
      permlink: r.permlink,
      created: toIso(r.created),
      parentAuthor: containerAuthor,
      parentPermlink: containerPermlink,
    }));
}

async function fetchContainerList(client, author, { beforeDate, beforePermlink = '', limit }) {
  const date = beforeDate ?? new Date().toISOString();
  const result = await client.database.call('get_discussions_by_author_before_date', [
    author, beforePermlink, date, limit,
  ]);
  return Array.isArray(result) ? result : [];
}

async function fetchContainerReplies(client, containerAuthor, containerPermlink) {
  const result = await client.database.call('get_content_replies', [containerAuthor, containerPermlink]);
  return Array.isArray(result) ? result : [];
}

// Walks up to `maxContainers` containers for a single source, starting from
// `beforeIso`. Used both for cold-start backfill and for the scroll-past-cache
// fallback. Returns `exhausted: true` when the author's own post history ran
// out before hitting the cap (i.e. we've truly reached the beginning).
async function walkContainers(client, source, beforeIso, maxContainers) {
  const list = await fetchContainerList(client, source.author, {
    beforeDate: beforeIso,
    limit: maxContainers,
  });

  const containers = [];
  for (const entry of list) {
    const replies = await fetchContainerReplies(client, source.author, entry.permlink);
    const items = buildPointerRecords(source.key, source.author, entry.permlink, replies);
    containers.push({ permlink: entry.permlink, created: toIso(entry.created), items });
  }

  return { containers, exhausted: list.length < maxContainers };
}

async function fallbackWalk(client, source, beforeIso, maxContainers = MAX_CONTAINERS_PER_FALLBACK_WALK) {
  return walkContainers(client, source, beforeIso, maxContainers);
}

async function hydrateItems(client, pointers) {
  const hydrated = await Promise.all(pointers.map(async (p) => {
    try {
      const content = await client.database.call('get_content', [p.author, p.permlink]);
      if (!content || !content.author) return null;
      return {
        source: p.source,
        author: p.author,
        permlink: p.permlink,
        created: p.created,
        parentAuthor: p.parentAuthor,
        parentPermlink: p.parentPermlink,
        body: content.body,
        json_metadata: content.json_metadata,
        active_votes: content.active_votes,
        children: content.children,
      };
    } catch (err) {
      console.log(`[hive-sidecar] feed: ERROR hydrating ${p.author}/${p.permlink} — ${err.message}`);
      return null;
    }
  }));
  return hydrated.filter(Boolean);
}

// Pure in-memory pointer index. No client dependency of its own — RPC calls
// happen in the standalone functions above and are handed in as plain data
// (upsertContainer/mergeFallbackContainers) or via an injectable walk
// function (getPage's fallback path), matching this codebase's other
// stateful modules (SnapEventLog, RollingWindow, AuthorTally).
class FeedIndex {
  constructor({
    maxContainersPerSource = MAX_INDEXED_CONTAINERS_PER_SOURCE,
    maxFallbackContainers = MAX_CONTAINERS_PER_FALLBACK_WALK,
    sources = SOURCES,
    fallbackWalkFn = fallbackWalk,
  } = {}) {
    this._maxContainersPerSource = maxContainersPerSource;
    this._maxFallbackContainers = maxFallbackContainers;
    this._sources = sources;
    this._fallbackWalkFn = fallbackWalkFn;
    // sourceKey -> container[] (newest-first)
    this._containers = new Map(sources.map(s => [s.key, []]));
    // sourceKey -> true once a fallback walk has confirmed there's no older history
    this._exhausted = new Map(sources.map(s => [s.key, false]));
  }

  _containersFor(sourceKey) {
    return this._containers.get(sourceKey) ?? [];
  }

  // Tick-driven growth path: prepends a genuinely new container and evicts
  // the oldest one past the cap, or replaces an existing container's items
  // in place (the "re-check the current head" case) without touching the cap.
  upsertContainer(sourceKey, container) {
    const list = this._containersFor(sourceKey);
    const existingIndex = list.findIndex(c => c.permlink === container.permlink);
    if (existingIndex !== -1) {
      list[existingIndex] = container;
      return false;
    }
    list.unshift(container);
    while (list.length > this._maxContainersPerSource) {
      list.pop();
    }
    return true;
  }

  // Bulk-set for cold start — caller guarantees the array already respects
  // the cap (coldStartFeedIndex fetches exactly maxContainersPerSource).
  seedContainers(sourceKey, containers) {
    this._containers.set(sourceKey, [...containers]);
  }

  // Deep-scroll fallback path: dedup-merges discovered containers so a
  // second visitor who scrolls that deep shortly after hits a warm index.
  // Deliberately does NOT evict down to maxContainersPerSource — that would
  // defeat the point of caching a deep scroll — but is bounded by a soft
  // ceiling (maxContainersPerSource + maxFallbackContainers) so repeated
  // deep scrolls can't grow a source's list unboundedly.
  mergeFallbackContainers(sourceKey, containers) {
    const list = this._containersFor(sourceKey);
    const known = new Set(list.map(c => c.permlink));
    for (const container of containers) {
      if (!known.has(container.permlink)) {
        list.push(container);
        known.add(container.permlink);
      }
    }
    list.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
    const softCeiling = this._maxContainersPerSource + this._maxFallbackContainers;
    while (list.length > softCeiling) list.pop();
    this._containers.set(sourceKey, list);
  }

  markExhausted(sourceKey) {
    this._exhausted.set(sourceKey, true);
  }

  containerCount(sourceKey) {
    return this._containersFor(sourceKey).length;
  }

  // Merged, created-descending pointer array across both sources. Recomputed
  // on demand (cheap relative to the RPC work that populates the index).
  _mergedPointers() {
    const all = [];
    for (const [, containers] of this._containers) {
      for (const container of containers) all.push(...container.items);
    }
    all.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
    return all;
  }

  get oldestIndexed() {
    const merged = this._mergedPointers();
    return merged.length ? merged[merged.length - 1].created : null;
  }

  get newestIndexed() {
    const merged = this._mergedPointers();
    return merged.length ? merged[0].created : null;
  }

  countSince(sinceMs) {
    const merged = this._mergedPointers();
    let count = 0;
    for (const item of merged) {
      if (Date.parse(item.created) > sinceMs) count++;
      else break;
    }
    return count;
  }

  _allSourcesExhausted() {
    return this._sources.every(s => this._exhausted.get(s.key));
  }

  async getPage(client, { before, limit = FEED_PAGE_LIMIT_DEFAULT } = {}) {
    let merged = this._mergedPointers();
    let needsFallback = before
      && !this._allSourcesExhausted()
      && !merged.some(item => item.created < before);

    if (needsFallback) {
      for (const source of this._sources) {
        if (this._exhausted.get(source.key)) continue;
        const { containers, exhausted } = await this._fallbackWalkFn(
          client, source, before, this._maxFallbackContainers,
        );
        this.mergeFallbackContainers(source.key, containers);
        if (exhausted) this.markExhausted(source.key);
      }
      merged = this._mergedPointers();
    }

    const startIndex = before ? merged.findIndex(item => item.created < before) : 0;
    const sliceStart = startIndex === -1 ? merged.length : Math.max(startIndex, 0);
    const page = merged.slice(sliceStart, sliceStart + limit);
    const hasMore = sliceStart + limit < merged.length || !this._allSourcesExhausted();

    return { items: page, hasMore };
  }
}

async function coldStartFeedIndex(client, feedIndex, sourcesConfig = SOURCES) {
  for (const source of sourcesConfig) {
    try {
      const { containers, exhausted } = await walkContainers(
        client, source, new Date().toISOString(), MAX_INDEXED_CONTAINERS_PER_SOURCE,
      );
      feedIndex.seedContainers(source.key, containers);
      if (exhausted) feedIndex.markExhausted(source.key);
      console.log(`[hive-sidecar] feed: cold-start indexed ${containers.length} ${source.key} containers`);
    } catch (err) {
      console.log(`[hive-sidecar] feed: ERROR cold-start walk failed for ${source.key} — ${err.message}`);
    }
  }
}

// Single tick: per source, a cheap limit=1 check for the newest container,
// immediately followed by fetching that container's replies. Whether the
// permlink is new (prepend) or unchanged (re-check the growing head), the
// same fetchContainerReplies + upsertContainer path handles both spec
// requirements ("detect a newer container" and "re-check the current head").
async function pollFeedIndex(client, feedIndex, failures = { snap: 0, wave: 0 }, sourcesConfig = SOURCES) {
  for (const source of sourcesConfig) {
    try {
      const list = await fetchContainerList(client, source.author, {
        beforeDate: new Date().toISOString(),
        limit: 1,
      });
      if (!list.length) {
        failures[source.key] = 0;
        continue;
      }
      const [entry] = list;
      const replies = await fetchContainerReplies(client, source.author, entry.permlink);
      const items = buildPointerRecords(source.key, source.author, entry.permlink, replies);
      const isNew = feedIndex.upsertContainer(source.key, {
        permlink: entry.permlink, created: toIso(entry.created), items,
      });
      failures[source.key] = 0;
      if (isNew) {
        console.log(`[hive-sidecar] feed: indexed ${source.key} container ${entry.permlink} (${items.length} replies)`);
      }
    } catch (err) {
      failures[source.key] = (failures[source.key] ?? 0) + 1;
      console.log(`[hive-sidecar] feed: ERROR poll tick failed for ${source.key} — ${err.message}`);
      if (failures[source.key] >= 5) {
        console.log(`[hive-sidecar] feed: 5 consecutive failures for ${source.key} — triggering node list refresh`);
        failures[source.key] = 0;
        try {
          const { resolveNodes } = require('./hive-client');
          const fresh = await resolveNodes();
          client.updateNodes(fresh);
          console.log(`[hive-sidecar] feed: node list refreshed: ${fresh.length} nodes`);
        } catch (refreshErr) {
          console.log(`[hive-sidecar] feed: node refresh also failed — ${refreshErr.message}`);
        }
      }
    }
  }
}

function startFeedPollLoop(client, feedIndex) {
  const failures = { snap: 0, wave: 0 };
  return setInterval(() => pollFeedIndex(client, feedIndex, failures), FEED_POLL_INTERVAL_MS);
}

module.exports = {
  FeedIndex,
  fetchContainerList,
  fetchContainerReplies,
  buildPointerRecords,
  fallbackWalk,
  hydrateItems,
  coldStartFeedIndex,
  pollFeedIndex,
  startFeedPollLoop,
  FEED_PAGE_LIMIT_DEFAULT,
  FEED_PAGE_LIMIT_MAX,
};
