/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Root path for resources
 */
const resourceRoot = '/vscode-resource';

/**
 * @template T
 * @typedef {{
 *     resolve: (x: T) => void,
 *     promise: Promise<T>
 * }} RequestStoreEntry
 */

/**
 * @template T
 */
class RequestStore {
	constructor() {
		/** @type {Map<string, RequestStoreEntry<T>>} */
		this.map = new Map();
	}

	/**
	 * @param {string} webviewId
	 * @param {string} path
	 * @return {RequestStoreEntry<T> | undefined}
	 */
	get(webviewId, path) {
		return this.map.get(this._key(webviewId, path));
	}

	/**
	 * @param {string} webviewId
	 * @param {string} path
	 */
	create(webviewId, path) {
		const existing = this.get(webviewId, path);
		if (existing) {
			return existing.promise;
		}
		let resolve;
		const promise = new Promise(r => resolve = r);
		this.map.set(this._key(webviewId, path), { resolve, promise });
		return promise;
	}

	/**
	 * @param {string} webviewId
	 * @param {string} path
	 * @param {T} result
	 * @return {boolean}
	 */
	resolve(webviewId, path, result) {
		const entry = this.get(webviewId, path);
		if (!entry) {
			return false;
		}
		entry.resolve(result);
		return true;
	}

	/**
	 * @param {string} webviewId
	 * @param {string} path
	 * @return {string}
	 */
	_key(webviewId, path) {
		return `${webviewId}@@@${path}`;
	}
}

/**
 * Map of requested paths to responses.
 *
 * @type {RequestStore<{ body: any, mime: string } | undefined>}
 */
const resourceRequestStore = new RequestStore();

/**
 * Map of requested localhost origins to optional redirects.
 *
 * @type {RequestStore<string | undefined>}
 */
const localhostRequestStore = new RequestStore();

const notFoundResponse = new Response('Not Found', {
	status: 404,
});


self.addEventListener('message', (event) => {
	switch (event.data.channel) {
		case 'did-load-resource':
			{
				const webviewId = getWebviewIdForClient(event.source);
				const data = event.data.data;
				const response = data.status === 200
					? { body: data.data, mime: data.mime }
					: undefined;

				if (!resourceRequestStore.resolve(webviewId, data.path, response)) {
					console.log('Could not resolve unknown resource', data.path);
				}
				return;
			}

		case 'did-load-localhost':
			{
				const webviewId = getWebviewIdForClient(event.source);
				const data = event.data.data;
				if (!localhostRequestStore.resolve(webviewId, data.origin, data.location)) {
					console.log('Could not resolve unknown localhost', data.origin);
				}
				return;
			}
	}

	console.log('Unknown message');
});

self.addEventListener('fetch', (event) => {
	const requestUrl = new URL(event.request.url);

	// See if it's a resource request
	if (requestUrl.origin === self.origin && requestUrl.pathname.startsWith(resourceRoot + '/')) {
		return event.respondWith(processResourceRequest(event, requestUrl));
	}

	// See if it's a localhost request
	if (requestUrl.origin !== self.origin && requestUrl.host.match(/^localhost:(\d+)$/)) {
		return event.respondWith(processLocalhostRequest(event, requestUrl));
	}
});

self.addEventListener('install', (event) => {
	event.waitUntil(self.skipWaiting()); // Activate worker immediately
});

self.addEventListener('activate', (event) => {
	event.waitUntil(self.clients.claim()); // Become available to all pages
});

async function processResourceRequest(event, requestUrl) {
	const client = await self.clients.get(event.clientId);
	if (!client) {
		console.log('Could not find inner client for request');
		return notFoundResponse.clone();
	}

	const webviewId = getWebviewIdForClient(client);
	const resourcePath = requestUrl.pathname.replace(resourceRoot, '');

	function resolveResourceEntry(entry) {
		if (!entry) {
			return notFoundResponse.clone();
		}
		return new Response(entry.body, {
			status: 200,
			headers: { 'Content-Type': entry.mime }
		});
	}

	const parentClient = await getOuterIframeClient(webviewId);
	if (!parentClient) {
		console.log('Could not find parent client for request');
		return notFoundResponse.clone();
	}

	// Check if we've already resolved this request
	const existing = resourceRequestStore.get(webviewId, resourcePath);
	if (existing) {
		return existing.promise.then(resolveResourceEntry);
	}

	parentClient.postMessage({
		channel: 'load-resource',
		path: resourcePath
	});

	return resourceRequestStore.create(webviewId, resourcePath)
		.then(resolveResourceEntry);
}

/**
 * @param {*} event
 * @param {URL} requestUrl
 */
async function processLocalhostRequest(event, requestUrl) {
	const client = await self.clients.get(event.clientId);
	if (!client) {
		// This is expected when requesting resources on other localhost ports
		// that are not spawned by vs code
		return undefined;
	}
	const webviewId = getWebviewIdForClient(client);
	const origin = requestUrl.origin;

	const resolveRedirect = redirectOrigin => {
		if (!redirectOrigin) {
			return fetch(event.request);
		}
		const location = event.request.url.replace(new RegExp(`^${requestUrl.origin}(/|$)`), `${redirectOrigin}$1`);
		return new Response(null, {
			status: 302,
			headers: {
				Location: location
			}
		});
	};

	const parentClient = await getOuterIframeClient(webviewId);
	if (!parentClient) {
		console.log('Could not find parent client for request');
		return notFoundResponse.clone();
	}

	// Check if we've already resolved this request
	const existing = localhostRequestStore.get(webviewId, origin);
	if (existing) {
		return existing.promise.then(resolveRedirect);
	}

	parentClient.postMessage({
		channel: 'load-localhost',
		origin: origin
	});

	return localhostRequestStore.create(webviewId, origin)
		.then(resolveRedirect);
}

function getWebviewIdForClient(client) {
	const requesterClientUrl = new URL(client.url);
	return requesterClientUrl.search.match(/\bid=([a-z0-9-]+)/i)[1];
}

async function getOuterIframeClient(webviewId) {
	const allClients = await self.clients.matchAll({ includeUncontrolled: true });
	return allClients.find(client => {
		const clientUrl = new URL(client.url);
		return clientUrl.pathname === '/' && clientUrl.search.match(new RegExp('\\bid=' + webviewId));
	});
}