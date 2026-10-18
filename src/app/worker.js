// The parsing worker (a module worker, served at /js/app/worker.js). All parsing and exporting happens here, off
// the page thread (decision B17); the page posts the located library (toWorkerSource) and gets back a preview, the
// structure-only dump and, after the licence check, the finished ZIP. The protocol is documented in pipeline.js.
//
// No network: this file and everything it imports read only what the page hands over.

import { CONFIG } from '../config.js';
import { Pipeline } from './pipeline.js';

const pipeline = new Pipeline({
  brand: CONFIG.brand,
  version: CONFIG.version,
  post: (message) => self.postMessage(message),
});

self.addEventListener('message', (event) => {
  void pipeline.handle(event.data);
});
