declare module 'mammoth/lib/zipfile.js' {
  export function openArrayBuffer(bytes: Buffer): Promise<{
    read(name: string, encoding: 'utf8'): Promise<string>
    write(name: string, value: string): void
    toArrayBuffer(): Promise<ArrayBuffer>
  }>
}

declare module 'mammoth/lib/xml/xmldom.js' {
  export interface XmlNode {
    nodeType: number
    localName: string
    namespaceURI: string
    textContent: string
    childNodes: ArrayLike<XmlNode>
    parentNode: XmlNode
    ownerDocument: XmlNode
    cloneNode(deep: boolean): XmlNode
    insertBefore(node: XmlNode, reference: XmlNode | null): XmlNode
    removeChild(node: XmlNode): XmlNode
    appendChild(node: XmlNode): XmlNode
    getElementsByTagNameNS(namespace: string, name: string): ArrayLike<XmlNode>
    createElementNS(namespace: string, name: string): XmlNode
    createTextNode(text: string): XmlNode
    setAttribute(name: string, value: string): void
    getAttribute(name: string): string
    toString(): string
  }
  export function parseFromString(xml: string): XmlNode
}
