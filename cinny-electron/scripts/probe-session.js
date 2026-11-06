const { app, session } = require('electron');
app.whenReady().then(() => {
  console.log('PROBE defaultSession:', typeof app.defaultSession,
    'session.defaultSession:', typeof session.defaultSession,
    'handler:', typeof (session.defaultSession || app.defaultSession)?.setPermissionCheckHandler);
  app.exit(0);
});
