module.exports = {
  apps: [{
    name: 'hive-activity-sidecar',
    script: './index.js',
    cwd: '/home/meno/hive-activity-sidecar',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '128M',
    env: {
      NODE_ENV: 'production',
      PORT: 3099,
    },
    error_file: '/home/meno/.pm2/logs/hive-activity-sidecar-error.log',
    out_file: '/home/meno/.pm2/logs/hive-activity-sidecar-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
