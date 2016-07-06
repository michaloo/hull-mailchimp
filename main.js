var Server = require('./server').Server;
var PORT = process.env.PORT || 8082;
console.warn("Starting on PORT " + PORT);
Server().listen(PORT);
