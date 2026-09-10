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

      // server.mjs never loads a .env itself — it reads process.env at import
      // time, before next() boots and does Next's own .env loading. Let Node
      // read the file instead, so secrets are in the process from the first
      // line and never appear in `pm2 env` or `ps`. Needs Node >= 20.6.
      // On a server this .env is a symlink to a file outside the release dir.
      node_args: ['--env-file=.env'],

      autorestart: true,
      // Next 15 + a Prisma client over ~91 models sits well above the old
      // 600M ceiling under load. Restarting drops every open WebSocket, so an
      // over-tight limit shows up as kitchen screens reconnecting all day.
      max_memory_restart: '900M',
      // Turn a crash loop into a visible stopped process rather than an
      // endless restart that looks like the app is running.
      min_uptime: '30s',
      max_restarts: 10,
      // server.mjs shutdown() gives itself 10s to drain sockets before it
      // force-exits. PM2's 1600ms default would SIGKILL it mid-drain.
      kill_timeout: 12000,

      env: {
        NODE_ENV: 'production',
        // 3000-3002 are taken on the target VPS: 3000 and 3001 by yoho-web /
        // yoho-api (yova.markui.lk), 3002 by travel-premium.markui.lk.
        PORT: 3010,
        // server.mjs defaults to 0.0.0.0, which publishes port 3000 on every
        // public IP. nginx is the only thing that should reach the app.
        HOSTNAME: '127.0.0.1',
      },
      out_file: './logs/app.out.log',
      error_file: './logs/app.err.log',
      time: true,
    },
  ],
}
