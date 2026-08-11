module.exports = {
  apps: [{
    name: 'hive-activity-sidecar',
    script: './index.js',
    cwd: '/var/www/activitytracker',
    instances: 1,
    // pm2 defaults to cluster mode whenever `instances` is set, even at 1 —
    // this app holds all its state in-process (feed index, rolling window,
    // patron maps), gets no benefit from cluster's extra master/worker IPC
    // hop, and running it that way is what caused the exec_mode drift found
    // during the 2026-08-11 crash-loop investigation (pm2's saved process
    // list said cluster_mode while this file never asked for it).
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    // Steady-state RSS for this process runs ~130-140MB (block window + feed
    // index + patron maps) — 128M was below normal operation, not a leak,
    // and caused pm2 to kill/cold-start the process every ~1.5-2h all day
    // (see pm2.log "exceeds --max-memory-restart" entries from 2026-08-11).
    // Set well above the observed ceiling so this only fires on a real leak.
    max_memory_restart: '350M',
    env: {
      NODE_ENV: 'production',
      PORT: 3099,
    },
    error_file: '/home/meno/.pm2/logs/hive-activity-sidecar-error.log',
    out_file: '/home/meno/.pm2/logs/hive-activity-sidecar-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
