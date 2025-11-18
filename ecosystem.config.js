/**
 * PM2 Ecosystem Configuration for Krapral Bot
 * 
 * Usage:
 *   npm run build
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2 startup  # Follow instructions to enable auto-start on reboot
 * 
 * Commands:
 *   pm2 logs krapral-bot      # View logs
 *   pm2 restart krapral-bot   # Restart bot
 *   pm2 stop krapral-bot      # Stop bot
 *   pm2 delete krapral-bot    # Remove from PM2
 */

module.exports = {
  apps: [
    {
      name: 'krapral-bot',
      script: './dist/bot.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info'
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      time: true
    }
  ]
};

