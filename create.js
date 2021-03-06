'use strict';
var url = require('url');
var assert = require('assert');
var debug = require('debug')('follow-redirects');
var consume = require('stream-consume');

module.exports = function (_nativeProtocols) {
	var nativeProtocols = {};

	var publicApi = {
		maxRedirects: 5
	};

	for (var p in _nativeProtocols) {
		/* istanbul ignore else */
		if (_nativeProtocols.hasOwnProperty(p)) {
			// http://www.ietf.org/rfc/rfc2396.txt - Section 3.1
			assert(/^[A-Z][A-Z\+\-\.]*$/i.test(p), JSON.stringify(p) + ' is not a valid scheme name');
			generateWrapper(p, _nativeProtocols[p]);
		}
	}

	return publicApi;

	function execute(options, callback) {
		var fetchedUrls = [];
		var clientRequest = cb();

		// return a proxy to the request with separate event handling
		var requestProxy = Object.create(clientRequest);
		requestProxy._events = {};
		requestProxy._eventsCount = 0;
		if (callback) {
			requestProxy.on('response', callback);
		}
		return requestProxy;

		function cb(res) {
			// skip the redirection logic on the first call.
			if (res) {
				var fetchedUrl = url.format(options);
				fetchedUrls.unshift(fetchedUrl);

				if (!isRedirect(res)) {
					res.fetchedUrls = fetchedUrls;
					requestProxy.emit('response', res);
					return;
				}

				// we are going to follow the redirect, but in node 0.10 we must first attach a data listener
				// to consume the stream and send the 'end' event
				consume(res);

				// need to use url.resolve() in case location is a relative URL
				var redirectUrl = url.resolve(fetchedUrl, res.headers.location);
				debug('redirecting to', redirectUrl);

				// clean all the properties related to the old url away, and copy from the redirect url
				wipeUrlProps(options);
				extend(options, url.parse(redirectUrl));
			}

			if (fetchedUrls.length > options.maxRedirects) {
				var err = new Error('Max redirects exceeded.');
				return forwardError(err);
			}

			options.nativeProtocol = nativeProtocols[options.protocol];
			options.defaultRequest = defaultMakeRequest;

			var req = (options.makeRequest || defaultMakeRequest)(options, cb, res);
			req.on('error', forwardError);
			return req;
		}

		function defaultMakeRequest(options, cb, res) {
			if (res && res.statusCode !== 307) {
				// This is a redirect, so use only GET methods, except for status 307,
				// which must honor the previous request method.
				options.method = 'GET';
			}

			var req = options.nativeProtocol.request(options, cb);

			if (res) {
				// We leave the user to call `end` on the first request
				req.end();
			}

			return req;
		}

		// bubble errors that occur on the redirect back up to the initiating client request
		// object, otherwise they wind up killing the process.
		function forwardError(err) {
			requestProxy.emit('error', err);
		}
	}

	function generateWrapper(scheme, nativeProtocol) {
		var wrappedProtocol = scheme + ':';
		var H = function () {};
		H.prototype = nativeProtocols[wrappedProtocol] = nativeProtocol;
		H = new H();
		publicApi[scheme] = H;

		H.request = function (options, callback) {
			return execute(parseOptions(options, wrappedProtocol), callback);
		};

		// see https://github.com/joyent/node/blob/master/lib/http.js#L1623
		H.get = function (options, callback) {
			var req = execute(parseOptions(options, wrappedProtocol), callback);
			req.end();
			return req;
		};
	}

	// returns a safe copy of options (or a parsed url object if options was a string).
	// validates that the supplied callback is a function
	function parseOptions(options, wrappedProtocol) {
		if (typeof options === 'string') {
			options = url.parse(options);
			options.maxRedirects = publicApi.maxRedirects;
		} else {
			options = extend({
				maxRedirects: publicApi.maxRedirects,
				protocol: wrappedProtocol
			}, options);
		}
		assert.equal(options.protocol, wrappedProtocol, 'protocol mismatch');

		debug('options', options);
		return options;
	}
};

// copies source's own properties onto destination and returns destination
function extend(destination, source) {
	for (var i in source) {
		if (source.hasOwnProperty(i)) {
			destination[i] = source[i];
		}
	}
	return destination;
}

// to redirect the result must have
// a statusCode between 300-399
// and a `Location` header
function isRedirect(res) {
	return (res.statusCode >= 300 && res.statusCode <= 399 &&
	'location' in res.headers);
}

var urlProps = ['protocol', 'slashes', 'auth', 'host', 'port', 'hostname',
	'hash', 'search', 'query', 'pathname', 'path', 'href'];

// nulls all url related properties on the object.
// required on node <10
function wipeUrlProps(options) {
	for (var i = 0, l = urlProps.length; i < l; ++i) {
		options[urlProps[i]] = null;
	}
}
