// PM2 Ecosystem Configuration
// Usage: pm2 start ecosystem.config.js

module.exports = {
  apps: [
    {
      name: 'gebeta-backend',
      script: './server.js',
      
      // Instances
      instances: 'max', // or a specific number like 2, 4
      exec_mode: 'cluster',
      
      // Environment variables
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      
      // Logging
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_file: './logs/pm2-combined.log',
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      
      // Restart configuration
      watch: false, // Set to true in development if needed
      ignore_watch: ['node_modules', 'logs', 'uploads', '.git'],
      max_memory_restart: '500M',
      
      // Restart on crash
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      
      // Graceful shutdown
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 10000,
      
      // Other options
      merge_logs: true,
      
      // Advanced features
      instance_var: 'INSTANCE_ID',
      
      // Post-deploy hooks (optional)
      // post_update: ['npm install', 'echo Deploy finished'],
    },
  ],

  // Deployment configuration (optional)
  deploy: {
    production: {
      user: 'deploy',
      host: ['your-server.com'],
      ref: 'origin/main',
      repo: 'git@github.com:your-repo/gebeta-delivery-backend.git',
      path: '/var/www/gebeta-backend',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env production',
      env: {
        NODE_ENV: 'production',
      },
    },
  },
};


