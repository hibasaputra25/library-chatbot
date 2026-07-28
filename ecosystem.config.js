/**
 * PM2 ECOSYSTEM CONFIGURATION
 * PustakaBot - Universitas Mercu Buana
 * 
 * This file configures PM2 to manage the chatbot processes.
 * 
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 reload ecosystem.config.js
 *   pm2 stop ecosystem.config.js
 *   pm2 delete ecosystem.config.js
 * 
 * Learn more: https://pm2.keymetrics.io/docs/usage/application-declaration/
 */

module.exports = {
  apps: [
    {
      // ================================================================
      // CHATBOT CORE SERVICE
      // ================================================================
      name: 'chatbot-core',
      script: './core_server.js',
      
      // Instance configuration
      instances: 1,  // Single instance for stateful application
      exec_mode: 'fork',  // Use 'cluster' for stateless multi-instance
      
      // Auto restart
      autorestart: true,
      watch: false,  // Set to true for development, false for production
      max_memory_restart: '500M',  // Restart if memory exceeds 500MB
      
      // Environment variables
      env: {
        NODE_ENV: 'production',
        PORT: 3003
      },
      
      env_development: {
        NODE_ENV: 'development',
        PORT: 3003
      },
      
      // Logging
      error_file: './logs/core-error.log',
      out_file: './logs/core-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      
      // Advanced options
      min_uptime: '10s',  // Min uptime before considering app stable
      max_restarts: 10,  // Max restarts within 1 minute before stopping
      restart_delay: 4000,  // Delay between restarts (ms)
      
      // Source map support (for better error stack traces)
      source_map_support: true,
      
      // Node.js options
      node_args: '--max-old-space-size=512',  // Max heap size 512MB
      
      // Graceful shutdown
      kill_timeout: 5000,  // Time to wait for graceful shutdown
      wait_ready: true,  // Wait for app ready signal
      listen_timeout: 10000,  // Timeout for app to be ready
    },
    
    {
      // ================================================================
      // WHATSAPP GATEWAY SERVICE
      // ================================================================
      name: 'chatbot-gateway',
      script: './wa_gateway.js',
      
      // Instance configuration
      instances: 1,  // Only one instance for WhatsApp session
      exec_mode: 'fork',
      
      // Auto restart
      autorestart: true,
      watch: false,
      max_memory_restart: '800M',  // WhatsApp session can use more memory
      
      // Environment variables
      env: {
        NODE_ENV: 'production',
        PORT: 3002
      },
      
      env_development: {
        NODE_ENV: 'development',
        PORT: 3002
      },
      
      // Logging
      error_file: './logs/gateway-error.log',
      out_file: './logs/gateway-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      
      // Advanced options
      min_uptime: '30s',  // WhatsApp init takes longer
      max_restarts: 15,  // Naikkan batas restart agar tidak berhenti saat error berulang
      restart_delay: 10000,  // 10s delay between restarts
      
      // Source map support
      source_map_support: true,
      
      // Node.js options
      node_args: '--max-old-space-size=1024',  // Max heap size 1GB for WhatsApp
      
      // Graceful shutdown
      kill_timeout: 15000,  // More time for WhatsApp to disconnect gracefully
      wait_ready: true,
      listen_timeout: 30000,  // WhatsApp initialization can take longer
    }
  ],
  
  // ================================================================
  // DEPLOYMENT CONFIGURATION (Optional)
  // ================================================================
  deploy: {
    production: {
      user: 'chatbot',
      host: 'your-server-ip',
      ref: 'origin/main',
      repo: 'git@github.com:your-username/server_chatbot.git',
      path: '/home/chatbot/apps/server_chatbot',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env production && pm2 save',
      'pre-setup': 'mkdir -p /home/chatbot/apps'
    },
    
    staging: {
      user: 'chatbot',
      host: 'staging-server-ip',
      ref: 'origin/develop',
      repo: 'git@github.com:your-username/server_chatbot.git',
      path: '/home/chatbot/apps/server_chatbot',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env development && pm2 save',
      'pre-setup': 'mkdir -p /home/chatbot/apps'
    }
  }
};
