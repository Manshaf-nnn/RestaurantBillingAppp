// PM2 process configuration — keeps RestaurantOS running and restarts it on
// crash or server reboot.
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup
//
// NOTE: a single instance (fork mode) is intentional — Socket.IO realtime runs
// in-process. To run multiple instances, set REDIS_URL and add the Socket.IO
// Redis adapter, then switch to cluster mode.
module.exports = {
  apps: [
    {
      name: 'restaurantos',
      script: 'server.mjs',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '600M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      out_file: './logs/app.out.log',
      error_file: './logs/app.err.log',
      time: true,
    },
  ],
}
