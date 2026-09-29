/** qrcode's browser SVG renderer avoids Node streams and external QR services. */
declare module 'qrcode/lib/browser.js' {
  import QRCode from 'qrcode'
  export default QRCode
}
