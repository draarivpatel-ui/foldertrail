// A tiny element builder for the views. Text always goes in as text (textContent / text nodes), never as
// HTML: library names are the user's own words and may contain anything. It refuses style="" and on...=""
// attributes (the Content-Security-Policy blocks them anyway) and javascript: URLs.

/**
 * @typedef {object} Props
 * @property {string} [class]
 * @property {string} [text]
 * @property {Record<string, string|number|boolean|null|undefined>} [attrs]
 * @property {Record<string, (event: any) => void>} [on]
 * @property {boolean} [hidden]
 */

/** @typedef {Node|string|number|null|undefined|false} Child */

/**
 * @param {string} tag
 * @param {Props|null} [props]
 * @param {...(Child|Child[])} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    if (props.class) el.className = props.class;
    if (props.attrs) {
      for (const [name, value] of Object.entries(props.attrs)) setAttr(el, name, value);
    }
    if (props.on) {
      for (const [type, handler] of Object.entries(props.on)) el.addEventListener(type, handler);
    }
    if (props.hidden) el.hidden = true;
    if (typeof props.text === 'string') el.textContent = props.text;
  }
  append(el, children);
  return el;
}

/**
 * @param {Element} el
 * @param {string} name
 * @param {string|number|boolean|null|undefined} value
 */
export function setAttr(el, name, value) {
  const lower = name.toLowerCase();
  if (lower === 'style' || lower.startsWith('on')) throw new Error(`refusing to set ${name}`);
  if (value === null || value === undefined || value === false) {
    el.removeAttribute(name);
    return;
  }
  const str = value === true ? '' : String(value);
  if ((lower === 'href' || lower === 'src' || lower === 'action') && /^\s*javascript:/i.test(str)) {
    throw new Error('refusing a javascript: URL');
  }
  el.setAttribute(name, str);
}

/**
 * @param {Node} parent
 * @param {(Child|Child[])[]} children
 */
export function append(parent, children) {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
}

/**
 * An icon from site/assets/icons, drawn in the current text colour.
 * @param {string} name
 * @param {string} [extra]  more classes
 */
export function icon(name, extra) {
  return h('span', { class: `icon icon-${name}${extra ? ` ${extra}` : ''}`, attrs: { 'aria-hidden': 'true' } });
}

/** @param {Node} el */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/**
 * Sets text only when it changed (keeps live regions from repeating themselves).
 * @param {Element|null} el
 * @param {string} value
 */
export function setText(el, value) {
  if (el && el.textContent !== value) el.textContent = value;
}

/**
 * @param {HTMLElement|null} el
 * @param {boolean} visible
 */
export function show(el, visible) {
  if (el && el.hidden === visible) el.hidden = !visible;
}

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
export function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}
