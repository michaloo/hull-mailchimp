const Server = require("./server").Server;
const PORT = process.env.PORT || 8082;
console.warn(`Starting on PORT ${PORT}`);
Server().listen(PORT);
