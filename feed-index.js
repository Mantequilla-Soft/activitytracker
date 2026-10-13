'use strict';

const path = require('path');
const { loadJsonState, saveJsonState } = require('./state-store');

const FEED_POLL_INTERVAL_MS = parseInt(process.env.FEED_POLL_INTERVAL_MS ?? '120000', 10); // 2 min
const FEED_INDEX_STATE_FILE = process.env.FEED_INDEX_STATE_FILE
  ?? path.join(__dirname, 'data', 'feed-index-state.json');
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

// Hydrated-item cache. Every /feed request used to fire one get_content RPC
// per item, uncached — with slow Hive nodes a deep page took 5-10s and the
// whole page was lost to one slow call. Items change slowly (votes drift),
// so a short TTL absorbs repeat/concurrent readers, and a stale entry is
// still better than dropping the item when the RPC fails.
const HYDRATE_TTL_MS = parseInt(process.env.FEED_HYDRATE_TTL_MS ?? '60000', 10);
const HYDRATE_STALE_MAX_MS = parseInt(process.env.FEED_HYDRATE_STALE_MAX_MS ?? '3600000', 10);
const HYDRATE_ITEM_DEADLINE_MS = parseInt(process.env.FEED_HYDRATE_ITEM_DEADLINE_MS ?? '4000', 10);
const HYDRATE_CACHE_MAX = parseInt(process.env.FEED_HYDRATE_CACHE_MAX ?? '2000', 10);
const hydrateCache = new Map(); // key -> { at, content }   (insertion order = LRU order)
const hydrateInflight = new Map(); // key -> Promise<content|null>

function cacheGet(key) {
  const entry = hydrateCache.get(key);
  if (!entry) return null;
  hydrateCache.delete(key); // refresh recency
  hydrateCache.set(key, entry);
  return entry;
}

function cacheSet(key, content) {
  hydrateCache.delete(key);
  hydrateCache.set(key, { at: Date.now(), content });
  while (hydrateCache.size > HYDRATE_CACHE_MAX) {
    hydrateCache.delete(hydrateCache.keys().next().value);
  }
}

function clearHydrateCache() {
  hydrateCache.clear();
  hydrateInflight.clear();
}

// Fetches get_content once, shared by concurrent callers, retrying a failed
// call once (dhive rotates to the next node on error). The result is written
// to the cache even if the caller's deadline already passed, so the next
// request finds it warm.
function fetchContent(client, key, author, permlink) {
  let inflight = hydrateInflight.get(key);
  if (inflight) return inflight;
  inflight = (async () => {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const content = await client.database.call('get_content', [author, permlink]);
        if (content && content.author) {
          cacheSet(key, content);
          return content;
        }
        return null; // legitimately absent (deleted/never existed)
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  })().finally(() => hydrateInflight.delete(key));
  hydrateInflight.set(key, inflight);
  return inflight;
}

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`hydration deadline ${ms}ms exceeded`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function hydrateOne(client, p) {
  const key = `${p.author}/${p.permlink}`;
  const cached = cacheGet(key);
  const now = Date.now();
  let content = null;
  if (cached && now - cached.at < HYDRATE_TTL_MS) {
    content = cached.content;
  } else {
    try {
      content = await withDeadline(fetchContent(client, key, p.author, p.permlink), HYDRATE_ITEM_DEADLINE_MS);
    } catch (err) {
      if (cached && now - cached.at < HYDRATE_STALE_MAX_MS) {
        content = cached.content; // stale beats missing
      } else {
        console.log(`[hive-sidecar] feed: ERROR hydrating ${p.author}/${p.permlink} — ${err.message}`);
        return null;
      }
    }
  }
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
}

async function hydrateItems(client, pointers) {
  const hydrated = await Promise.all(pointers.map(p => hydrateOne(client, p)));
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
    stateFile = FEED_INDEX_STATE_FILE,
  } = {}) {
    this._maxContainersPerSource = maxContainersPerSource;
    this._maxFallbackContainers = maxFallbackContainers;
    this._sources = sources;
    this._fallbackWalkFn = fallbackWalkFn;
    this._stateFile = stateFile;
    // sourceKey -> container[] (newest-first)
    this._containers = new Map(sources.map(s => [s.key, []]));
    // sourceKey -> true once a fallback walk has confirmed there's no older history
    this._exhausted = new Map(sources.map(s => [s.key, false]));
  }

  // Restores the last known-good index from disk so /feed can serve real
  // (if slightly stale) data immediately after a restart instead of the
  // blank-until-cold-start-finishes response server.js falls back to —
  // pm2 restarts this process on every deploy and every memory-limit hit,
  // and each one used to mean 2-4 minutes of an empty feed for anyone
  // loading the page in that window. Deliberately does NOT restore
  // `_exhausted` — that flag means "confirmed no older history via a real
  // RPC walk", which a disk load can't re-confirm on its own.
  load() {
    const saved = loadJsonState(this._stateFile);
    if (!saved || typeof saved !== 'object' || !saved.containers) return;
    for (const source of this._sources) {
      const containers = saved.containers[source.key];
      if (Array.isArray(containers)) this._containers.set(source.key, containers);
    }
  }

  // Persists just the pointer index (author/permlink/created, not hydrated
  // bodies) — cheap enough to call after every cold-start and poll-tick
  // write rather than on a timer.
  save() {
    saveJsonState(this._stateFile, { containers: Object.fromEntries(this._containers) });
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
  // Persist whatever came out of this pass (even a partial one — a source
  // that failed above just keeps whatever load() restored from last time)
  // so the next restart has this run's data to fall back on, not last run's.
  feedIndex.save();
}

// Single tick: per source, a cheap limit=1 check for the newest container,
// immediately followed by fetching that container's replies. Whether the
// permlink is new (prepend) or unchanged (re-check the growing head), the
// same fetchContainerReplies + upsertContainer path handles both spec
// requirements ("detect a newer container" and "re-check the current head").
async function pollFeedIndex(client, feedIndex, failures = { snap: 0, wave: 0 }, sourcesConfig = SOURCES, state = null) {
  let changed = false;
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
      changed = true;
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
          const { resolveNodes, applyNodeRefresh } = require('./hive-client');
          const fresh = await resolveNodes();
          applyNodeRefresh(client, fresh);
          console.log(`[hive-sidecar] feed: node list refreshed: ${fresh.length} nodes`);
        } catch (refreshErr) {
          console.log(`[hive-sidecar] feed: node refresh also failed — ${refreshErr.message}`);
        }
      }
    }
  }
  if (changed) feedIndex.save();
  // Marks this cycle as having attempted every source (success or handled
  // failure) — see the matching comment in poller.js's tick(). A source whose
  // RPC call hangs mid-await never reaches its catch block, so the loop never
  // gets here and the watchdog in index.js sees a growing staleness gap.
  if (state) state.lastFeedTickCompletedAt = Date.now();
}

function startFeedPollLoop(client, feedIndex, state = null) {
  const failures = { snap: 0, wave: 0 };
  return setInterval(() => pollFeedIndex(client, feedIndex, failures, SOURCES, state), FEED_POLL_INTERVAL_MS);
}

module.exports = {
  FeedIndex,
  fetchContainerList,
  fetchContainerReplies,
  buildPointerRecords,
  fallbackWalk,
  hydrateItems,
  clearHydrateCache,
  coldStartFeedIndex,
  pollFeedIndex,
  startFeedPollLoop,
  FEED_PAGE_LIMIT_DEFAULT,
  FEED_PAGE_LIMIT_MAX,
};
