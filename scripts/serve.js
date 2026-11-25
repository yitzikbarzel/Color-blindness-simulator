'use strict';
// Local dev server: `npm start`. Uses http://localhost, which browsers treat as a
// secure context, so the live camera works without HTTPS.
const { startServer } = require('../tests/helpers/server.js');

startServer(Number(process.env.PORT) || 8080).then(({ url }) => {
    console.log(`Color blindness simulator running at ${url.replace('127.0.0.1', 'localhost')}`);
});
