// Starts the converter page (site/app/index.html).
//
// This file is deliberately written in older JavaScript (no ?. or ??) and imports nothing up front: on a
// browser too old to run the app, such as Safari on macOS 10.13 or 10.14, it must still run far enough to
// say so plainly. Only when module workers are available does it load the app itself.
//
// The settings (../config.js) and the licence check (./license.js) are loaded when present; without them
// the page offers the free preview only.

var bootNote = document.getElementById('boot-note');

function moduleWorkersSupported() {
  // A browser that knows module workers reads the `type` option while it converts the arguments, before it
  // looks at the URL. This URL cannot be parsed, so no worker starts and nothing is fetched.
  if (typeof Worker !== 'function') return false;
  var read = false;
  var options = {};
  Object.defineProperty(options, 'type', {
    get: function () {
      read = true;
      return 'module';
    },
  });
  try {
    new Worker('http://[', options);
  } catch (error) {
    // expected
  }
  return read;
}

function showTooOld() {
  var view = document.getElementById('view-open');
  var box = document.getElementById('support-blocking');
  var text = document.getElementById('support-blocking-text');
  if (!view || !box || !text) return;
  text.textContent =
    'This browser is too old to run Foldertrail. On macOS 10.13 or 10.14, Safari can’t be updated far enough: ' +
    'use a current version of Chrome or Firefox instead. On a newer Mac, update Safari or use Chrome or Firefox.';
  box.hidden = false;
  var buttons = ['choose-folder', 'choose-file'];
  for (var i = 0; i < buttons.length; i++) {
    var button = document.getElementById(buttons[i]);
    if (button) button.disabled = true;
  }
  var zone = document.getElementById('dropzone');
  if (zone) zone.className += ' is-disabled';
  var first = document.querySelector('.step');
  if (first) first.className += ' is-current';
  if (bootNote) bootNote.hidden = true;
  view.hidden = false;
}

function optional(path) {
  return import(path).then(
    function (module) {
      return module;
    },
    function () {
      return null;
    },
  );
}

function start() {
  if (!moduleWorkersSupported()) {
    showTooOld();
    return;
  }
  Promise.all([import('./view-app.js'), optional('../config.js'), optional('./license.js')])
    .then(function (modules) {
      var app = modules[0];
      var config = modules[1];
      var license = modules[2];
      app.startApp({
        config: config && config.CONFIG ? config.CONFIG : null,
        isConfigured: config && typeof config.isConfigured === 'function' ? config.isConfigured : null,
        license: license,
      });
    })
    .catch(function () {
      // The app could not load: the note in the page says so straight away.
      if (bootNote) bootNote.classList.add('is-now');
    });
}

start();
