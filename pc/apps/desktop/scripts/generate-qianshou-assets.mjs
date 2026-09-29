import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const resources = new URL('../resources/', import.meta.url)
const installer = new URL('../installer/assets/', import.meta.url)
const arms = Array.from({ length: 6 }, (_, index) =>
  `<path d="M16 11.7C16 9.3 19.7 10.3 19.7 7.7" transform="rotate(${index * 60} 16 16)"/>`).join('')
const glyph = (color) => `<g fill="${color}"><circle cx="16" cy="16" r="2.45"/></g>
  <g fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round">${arms}</g>`
const tile = (radius, background = '#147d72', foreground = '#ffffff') =>
  `<rect x="1" y="1" width="30" height="30" rx="${radius}" fill="${background}"/>${glyph(foreground)}`
const svg = (width, height, viewBox, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}">${body}</svg>\n`

async function save(url, markup, png) {
  if (url.pathname.endsWith('.svg')) await writeFile(url, markup)
  else await sharp(Buffer.from(markup)).png().toFile(fileURLToPath(url))
  if (png !== undefined) await sharp(Buffer.from(markup)).png().toFile(fileURLToPath(png))
}

const macIcon = svg(1024, 1024, '0 0 32 32', tile(9))
const windowsIcon = svg(1024, 1024, '0 0 32 32', tile(6.5))
await save(new URL('qianshou-icon-macos.svg', resources), macIcon, new URL('qianshou-icon-macos.png', resources))
await save(new URL('qianshou-icon-windows.svg', resources), windowsIcon, new URL('qianshou-icon-windows.png', resources))
await save(new URL('qianshou-tray-macosTemplate.png', resources), svg(18, 18, '4 4 24 24', glyph('#000000')))
await save(new URL('qianshou-tray-macosTemplate@2x.png', resources), svg(36, 36, '4 4 24 24', glyph('#000000')))
await save(new URL('qianshou-tray-windows.png', resources), svg(32, 32, '0 0 32 32', tile(8)))

function installerBrand(dark, scale) {
  const foreground = dark ? '#f2fbf9' : '#172b28'
  const secondary = dark ? '#a9c8c2' : '#5f7772'
  return svg(600 * scale, 196 * scale, '0 0 600 196', `
    <g transform="translate(44 43) scale(3.45)">${tile(8)}</g>
    <text x="187" y="104" font-family="PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif"
      font-size="64" font-weight="700" letter-spacing="4" fill="${foreground}">千手</text>
    <text x="191" y="142" font-family="Arial, sans-serif" font-size="21" font-weight="700"
      letter-spacing="5" fill="${secondary}">QIANSHOU AI</text>`)
}
for (const dark of [false, true]) {
  const suffix = dark ? '-dark' : ''
  await save(new URL(`qianshou-brand${suffix}.png`, installer), installerBrand(dark, 1))
  await save(new URL(`qianshou-brand${suffix}-2x.png`, installer), installerBrand(dark, 2))
}
await save(new URL('qianshou-uninstaller-sidebar.png', installer), svg(164, 314, '0 0 164 314', `
  <rect width="164" height="314" fill="#f5fbf9"/>
  <g transform="translate(25 88) scale(3.55)">${tile(8)}</g>
  <text x="82" y="242" text-anchor="middle"
    font-family="PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif"
    font-size="23" font-weight="700" letter-spacing="2" fill="#173e38">千手</text>`))
