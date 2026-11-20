// 아주 작은 가짜 DOM: react-dom/client 가 돌 만큼만
class Node {
  constructor(type, name, doc) { this.nodeType = type; this.nodeName = name; this.tagName = name; this.childNodes = []; this.parentNode = null; this.ownerDocument = doc; this.attributes = {}; this.style = {}; this._listeners = {}; this.namespaceURI = 'http://www.w3.org/1999/xhtml' }
  get firstChild() { return this.childNodes[0] ?? null }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null }
  get nextSibling() { if (!this.parentNode) return null; const s = this.parentNode.childNodes; return s[s.indexOf(this) + 1] ?? null }
  get previousSibling() { if (!this.parentNode) return null; const s = this.parentNode.childNodes; return s[s.indexOf(this) - 1] ?? null }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c }
  insertBefore(c, ref) { if (!ref) return this.appendChild(c); if (c.parentNode) c.parentNode.removeChild(c); const i = this.childNodes.indexOf(ref); c.parentNode = this; this.childNodes.splice(i, 0, c); return c }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c }
  setAttribute(k, v) { this.attributes[k] = String(v) }
  getAttribute(k) { return this.attributes[k] ?? null }
  removeAttribute(k) { delete this.attributes[k] }
  hasAttribute(k) { return k in this.attributes }
  addEventListener(t, f) { (this._listeners[t] ??= []).push(f) }
  removeEventListener(t, f) { this._listeners[t] = (this._listeners[t] ?? []).filter(x => x !== f) }
  dispatchEvent() { return true }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(c => c.textContent).join('') }
  set textContent(v) { this.childNodes = []; if (v !== '' && v != null) { const t = this.ownerDocument.createTextNode(String(v)); t.parentNode = this; this.childNodes.push(t) } }
  get data() { return this.nodeValue } set data(v) { this.nodeValue = v }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode } return false }
  getRootNode() { let n = this; while (n.parentNode) n = n.parentNode; return n }
}
export function install() {
  const doc = new Node(9, '#document', null); doc.ownerDocument = doc
  doc.createElement = n => new Node(1, n.toUpperCase(), doc)
  doc.createElementNS = (ns, n) => new Node(1, n.toUpperCase(), doc)
  doc.createTextNode = t => { const n = new Node(3, '#text', doc); n.nodeValue = String(t); return n }
  doc.createComment = t => { const n = new Node(8, '#comment', doc); n.nodeValue = t; return n }
  doc.documentElement = doc.createElement('html'); doc.appendChild(doc.documentElement)
  doc.body = doc.createElement('body'); doc.documentElement.appendChild(doc.body)
  doc.head = doc.createElement('head')
  doc.defaultView = globalThis
  doc.activeElement = doc.body
  globalThis.document = doc
  globalThis.window = globalThis
  globalThis.HTMLElement = Node; globalThis.HTMLIFrameElement = class {}; globalThis.Node = Node
  globalThis.navigator ??= { userAgent: 'node' }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return doc
}
