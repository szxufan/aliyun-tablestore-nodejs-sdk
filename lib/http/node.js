var TableStore = require('../core');
var Stream = require('stream').Stream;
var WritableStream = require('stream').Writable;
var ReadableStream = require('stream').Readable;
require('../http');

const HttpAgent = require("agentkeepalive");
const HttpsAgent = HttpAgent.HttpsAgent;

const keepaliveHttpAgent = new HttpAgent({
  maxSockets: 300,
  maxFreeSockets: 50,
  timeout: 60_000,
  freeSocketTimeout: 8_000,
});
const keepaliveHttpsAgent = new HttpsAgent({
  maxSockets: 300,
  maxFreeSockets: 50,
  timeout: 60_000,
  freeSocketTimeout: 8_000,
});

/**
 * @api private
 */
TableStore.NodeHttpClient = TableStore.util.inherit({
  handleRequest: function handleRequest(httpRequest, httpOptions, callback, errCallback) {
    var endpoint = httpRequest.endpoint;
    var pathPrefix = '';
    if (!httpOptions) httpOptions = {};

    var useSSL = endpoint.protocol === 'https:';
    var http = useSSL ? require('https') : require('http');
    if (httpOptions.maxSockets) {
      http.globalAgent.maxSockets = httpOptions.maxSockets;
    } else {
      http.globalAgent.maxSockets = 300;
    }
    var options = {
      host: endpoint.hostname,
      port: endpoint.port,
      method: httpRequest.method,
      headers: httpRequest.headers,
      path: pathPrefix + httpRequest.path
    };

    if (useSSL) {
      options.agent = this.sslAgent();
    } else {
      options.agent = keepaliveHttpAgent;
    }

    TableStore.util.update(options, httpOptions);
    delete options.proxy; // proxy isn't an HTTP option
    delete options.timeout; // timeout isn't an HTTP option
    delete options.maxSockets; // maxSockets isn't an HTTP option

    var stream = http.request(options, function (httpResp) {
      callback(httpResp);
      httpResp.emit('headers', httpResp.statusCode, httpResp.headers);
    });
    httpRequest.stream = stream; // attach stream to httpRequest

    // timeout support
    stream.setTimeout(httpOptions.timeout || 0);
    stream.once('timeout', function () {
      var msg = 'Connection timed out after ' + httpOptions.timeout + 'ms';
      errCallback(TableStore.util.error(new Error(msg), { code: 'TimeoutError' }));

      // HACK - abort the connection without tripping our error handler
      // since we already raised our TimeoutError. Otherwise the connection
      // comes back with ECONNRESET, which is not a helpful error message
      stream.removeListener('error', errCallback);
      stream.on('error', function () { });
      stream.abort();
    });

    stream.on('error', errCallback);
    this.writeBody(stream, httpRequest);
    return stream;
  },

  writeBody: function writeBody(stream, httpRequest) {
    var body = httpRequest.body;

    if (body && WritableStream && ReadableStream) { // progress support
      if (!(body instanceof Stream)) body = this.bufferToStream(body);
      body.pipe(this.progressStream(stream, httpRequest));
    }

    if (body instanceof Stream) {
      body.pipe(stream);
    } else if (body) {
      stream.end(body);
    } else {
      stream.end();
    }
  },

  sslAgent: function sslAgent() {
    var https = require('https');

    if (!TableStore.NodeHttpClient.sslAgent) {
      TableStore.NodeHttpClient.sslAgent = keepaliveHttpsAgent;
      TableStore.NodeHttpClient.sslAgent.setMaxListeners(0);
    }
    return TableStore.NodeHttpClient.sslAgent;
  },

  progressStream: function progressStream(stream, httpRequest) {
    var numBytes = 0;
    var totalBytes = httpRequest.headers['Content-Length'];
    var writer = new WritableStream();
    writer._write = function (chunk, encoding, callback) {
      if (chunk) {
        numBytes += chunk.length;
        stream.emit('sendProgress', {
          loaded: numBytes, total: totalBytes
        });
      }
      callback();
    };
    return writer;
  },

  bufferToStream: function bufferToStream(buffer) {
    if (!TableStore.util.Buffer.isBuffer(buffer)) buffer = new TableStore.util.Buffer(buffer);

    var readable = new ReadableStream();
    var pos = 0;
    readable._read = function (size) {
      if (pos >= buffer.length) return readable.push(null);

      var end = pos + size;
      if (end > buffer.length) end = buffer.length;
      readable.push(buffer.slice(pos, end));
      pos = end;
    };

    return readable;
  },

  emitter: null
});

/**
 * @!ignore
 */

/**
 * @api private
 */
TableStore.HttpClient.prototype = TableStore.NodeHttpClient.prototype;

/**
 * @api private
 */
TableStore.HttpClient.streamsApiVersion = ReadableStream ? 2 : 1;
