import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement>

function base(props: P, extra: SVGProps<SVGSVGElement> = {}) {
  return {
    viewBox: '0 0 24 24',
    fill: 'none',
    'aria-hidden': true as const,
    ...extra,
    ...props,
  }
}

function stroke(props: P) {
  return base(props, {
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  })
}

export function BrandMark(props: P) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" {...props}>
      <circle cx="16" cy="16" r="2.55" fill="currentColor" />
      <g fill="none" stroke="currentColor" strokeWidth="2.35" strokeLinecap="round">
        { [0, 60, 120, 180, 240, 300].map(deg => (
          <path key={deg} d="M16 11.15C16 8.55 20.15 9.7 20.15 6.75" transform={`rotate(${deg} 16 16)`} />
        )) }
      </g>
    </svg>
  )
}

export function IcoMenu(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M5 7.25h14M5 12h14M5 16.75h14" />
    </svg>
  )
}

export function IcoClose(props: P) {
  return (
    <svg {...stroke({ ...props, strokeWidth: 2 })}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

export function IcoChevron(props: P) {
  return (
    <svg {...stroke({ ...props, strokeWidth: 1.7 })}>
      <path d="m9 5.5 6.5 6.5L9 18.5" />
    </svg>
  )
}

export function IcoBack(props: P) {
  return (
    <svg {...stroke({ ...props, strokeWidth: 2 })}>
      <path d="M15 5 8 12l7 7" />
    </svg>
  )
}

export function IcoSpark(props: P) {
  return (
    <svg {...base(props)}>
      <path fill="currentColor" d="M12 2.8 13.35 8.4 19 9.8l-5.65 1.4L12 16.8l-1.35-5.6L5 9.8l5.65-1.4Z" />
    </svg>
  )
}

export function IcoCaret(props: P) {
  return (
    <svg {...stroke({ ...props, strokeWidth: 1.8 })}>
      <path d="m7 10 5 5 5-5" />
    </svg>
  )
}

export function IcoDoc(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M8 4h6.2L18 8.2V19a1.4 1.4 0 0 1-1.4 1.4H8A1.4 1.4 0 0 1 6.6 19V5.4A1.4 1.4 0 0 1 8 4Z" />
      <path d="M14.1 4v4.3H18M9.2 13h5.8M9.2 16.2h4" />
    </svg>
  )
}

export function IcoBars(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M6 18V11M10.5 18V6.5M15 18v-8M19.5 18V9" />
    </svg>
  )
}

export function IcoImage(props: P) {
  return (
    <svg {...stroke(props)}>
      <rect x="4.2" y="5.2" width="15.6" height="13.6" rx="2.2" />
      <circle cx="9.1" cy="10" r="1.35" />
      <path d="m7.2 16.8 3.4-3.6 2.3 2.4 2.8-3.1 3.3 4.3" />
    </svg>
  )
}

export function IcoCode(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="m8.2 8-3.7 4 3.7 4M15.8 8l3.7 4-3.7 4M13.2 7.2l-2.4 9.6" />
    </svg>
  )
}

export function IcoChat(props: P & { filled?: boolean }) {
  const { filled, ...rest } = props
  return filled ? (
    <svg {...base(rest)}>
      <path fill="currentColor" d="M12 3.4c-4.7 0-8.5 3.3-8.5 7.4 0 2.3 1.2 4.4 3.2 5.8L5.4 20.7l4.2-1.2c.8.2 1.6.3 2.4.3 4.7 0 8.5-3.3 8.5-7.4S16.7 3.4 12 3.4Z" />
    </svg>
  ) : (
    <svg {...stroke(rest)}>
      <path d="M19.4 11.2c0 3.7-3.4 6.7-7.5 6.7-1.1 0-2.1-.2-3-.6L5.2 18.6l.9-3.5c-1.3-1.2-2.1-2.8-2.1-4.6 0-3.7 3.4-6.7 7.5-6.7s7.9 3 7.9 6.4Z" />
    </svg>
  )
}

export function IcoGrid(props: P & { filled?: boolean }) {
  const { filled, ...rest } = props
  const r = filled ? 2.15 : 1.55
  return (
    <svg {...base(rest)}>
      {[7.2, 16.8].flatMap(x => [7.2, 16.8].map(y => (
        <rect key={`${x}-${y}`} x={x - r} y={y - r} width={r * 2} height={r * 2} rx={filled ? 1.1 : 0.7} fill="currentColor" />
      )))}
    </svg>
  )
}

export function IcoDiscover(props: P & { filled?: boolean }) {
  const { filled, ...rest } = props
  return filled ? (
    <svg {...base(rest)}>
      <path fill="currentColor" d="M12 3.2A8.8 8.8 0 1 0 20.8 12 8.8 8.8 0 0 0 12 3.2Zm2.9 5.3-1.4 4.6-4.6 1.4 1.4-4.6 4.6-1.4Z" />
    </svg>
  ) : (
    <svg {...stroke(rest)}>
      <circle cx="12" cy="12" r="8" />
      <path d="m15.1 8.9-1.4 4.5-4.5 1.4 1.4-4.5 4.5-1.4Z" />
    </svg>
  )
}

export function IcoTask(props: P & { filled?: boolean }) {
  const { filled, ...rest } = props
  return filled ? (
    <svg {...base(rest)}>
      <path fill="currentColor" d="M7.2 3.6h9.6A2.4 2.4 0 0 1 19.2 6v13.2a2.4 2.4 0 0 1-2.4 2.4H7.2A2.4 2.4 0 0 1 4.8 19.2V6A2.4 2.4 0 0 1 7.2 3.6Zm1.9 9.1 1.9 1.9 4.3-4.4 1.1 1.1-5.4 5.5-3-3 1.1-1.1Z" />
    </svg>
  ) : (
    <svg {...stroke(rest)}>
      <rect x="5.4" y="4.2" width="13.2" height="15.6" rx="2.1" />
      <path d="m8.4 12.1 2.3 2.3 5-5.1" />
    </svg>
  )
}

export function IcoMe(props: P & { filled?: boolean }) {
  const { filled, ...rest } = props
  return filled ? (
    <svg {...base(rest)}>
      <circle cx="12" cy="8" r="3.3" fill="currentColor" />
      <path fill="currentColor" d="M5.2 19.6c.7-3.6 3.3-5.5 6.8-5.5s6.1 1.9 6.8 5.5a8.8 8.8 0 0 1-13.6 0Z" />
    </svg>
  ) : (
    <svg {...stroke(rest)}>
      <circle cx="12" cy="8" r="3.15" />
      <path d="M6.2 19c.8-3.1 3.1-4.8 5.8-4.8s5 1.7 5.8 4.8" />
    </svg>
  )
}

export function IcoBolt(props: P & { filled?: boolean }) {
  const { filled, ...rest } = props
  return (
    <svg {...base(rest)}>
      <path
        d="M13.2 3.2 6.8 13h4.3l-1.2 7.8 7.2-11.2h-4.4L13.2 3.2Z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={filled ? 0 : 1.7}
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function IcoPlus(props: P) {
  return (
    <svg {...stroke({ ...props, strokeWidth: 2 })}>
      <path d="M12 6.2v11.6M6.2 12h11.6" />
    </svg>
  )
}

export function IcoMic(props: P) {
  return (
    <svg {...stroke(props)}>
      <rect x="9.1" y="3.4" width="5.8" height="10.6" rx="2.9" />
      <path d="M6.4 11.6v1.3a5.6 5.6 0 0 0 11.2 0v-1.3M12 18.3v2.3M9.4 20.6h5.2" />
    </svg>
  )
}

export function IcoSend(props: P) {
  return (
    <svg {...stroke({ ...props, strokeWidth: 2.15 })}>
      <path d="M12 17.8V6.6M7.4 11.4 12 6.6l4.6 4.8" />
    </svg>
  )
}

export function IcoGlobe(props: P) {
  return (
    <svg {...stroke({ ...props, strokeWidth: 1.65 })}>
      <circle cx="12" cy="12" r="8" />
      <path d="M4.2 12h15.6M12 4c2.5 2.7 3.7 5.4 3.7 8S14.5 17.3 12 20c-2.5-2.7-3.7-5.4-3.7-8S9.5 6.7 12 4Z" />
    </svg>
  )
}

export function IcoThink(props: P) {
  return (
    <svg {...stroke({ ...props, strokeWidth: 1.65 })}>
      <path d="M9.1 17.7h5.8M10 20.4h4" />
      <path d="M8.1 15.2c-1.8-1.3-3-3.2-3-5.2A6.9 6.9 0 0 1 18.9 10c0 2-1.2 3.9-3 5.2H8.1Z" />
    </svg>
  )
}

export function IcoWrench(props: P) {
  return (
    <svg {...stroke({ ...props, strokeWidth: 1.65 })}>
      <path d="M14.7 6.4a3.5 3.5 0 0 0-4.7 4.7L4.2 16.9V20h3.1l5.8-5.8a3.5 3.5 0 0 0 4.7-4.7L15.3 12 12 8.7l2.7-2.3Z" />
    </svg>
  )
}

export function IcoUpload(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M12 15.6V7.2M8.3 10.2 12 6.5l3.7 3.7" />
      <path d="M6 17.4v1.4A1.6 1.6 0 0 0 7.6 20.4h8.8a1.6 1.6 0 0 0 1.6-1.6v-1.4" />
    </svg>
  )
}

export function IcoRefresh(props: P) {
  return (
    <svg {...stroke({ ...props, strokeWidth: 1.7 })}>
      <path d="M19.4 7V11.6h-4.6" />
      <path d="M19.3 11.5A7.4 7.4 0 1 1 16.7 6.2" />
    </svg>
  )
}

export function IcoSearch(props: P) {
  return (
    <svg {...stroke(props)}>
      <circle cx="11" cy="11" r="6.2" />
      <path d="m15.6 15.6 4 4" />
    </svg>
  )
}

export function IcoBell(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M6.4 9.4a5.6 5.6 0 0 1 11.2 0c0 4.4 1.4 5.6 1.4 5.6H5s1.4-1.2 1.4-5.6Z" />
      <path d="M10 18.4a2 2 0 0 0 4 0" />
    </svg>
  )
}

export function IcoStar(props: P) {
  return (
    <svg {...base(props)}>
      <path fill="currentColor" d="m12 3.2 2.1 5.5 5.9.4-4.5 3.7 1.4 5.7L12 15.8 6.99 18.5l1.4-5.7-4.5-3.7 5.9-.4Z" />
    </svg>
  )
}

export function IcoBrief(props: P) {
  return (
    <svg {...stroke(props)}>
      <rect x="4" y="8" width="16" height="11.2" rx="2" />
      <path d="M9 8V6.4A1.4 1.4 0 0 1 10.4 5h3.2A1.4 1.4 0 0 1 15 6.4V8M4 13h16" />
    </svg>
  )
}

export function IcoScale(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M12 4.2v15.4M8 19.6h8M12 6.4 6.2 14h5.2L12 6.4 17.8 14H12.6" />
    </svg>
  )
}

export function IcoMegaphone(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M5.2 10.4v3.2A1.4 1.4 0 0 0 6.6 15h1.3l1.6 4h2.2l-1.1-4H18.6a.8.8 0 0 0 .8-.8V8.2a.8.8 0 0 0-.8-.8H6.6A1.4 1.4 0 0 0 5.2 8.8v1.6Z" />
    </svg>
  )
}

export function IcoPen(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M14.2 5.2 18.8 9.8 9 19.6H4.4V15Z" />
      <path d="m12.4 7 4.6 4.6" />
    </svg>
  )
}

export function IcoCap(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="m3.4 10.2 8.6-4.8 8.6 4.8-8.6 4.8-8.6-4.8Z" />
      <path d="M7.2 12.4v3.8c2.1 1.4 7.5 1.4 9.6 0v-3.8" />
    </svg>
  )
}

export function IcoPlay(props: P) {
  return (
    <svg {...stroke(props)}>
      <rect x="4.2" y="6.2" width="15.6" height="11.6" rx="3" />
      <path fill="currentColor" stroke="none" d="M10.6 9.6v4.8l4.2-2.4-4.2-2.4Z" />
    </svg>
  )
}

export function IcoTrend(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M4.4 16.4 9 11.8l3.2 3.2 7.4-7.4" />
      <path d="M14.6 7.6h5v5" />
    </svg>
  )
}

export function IcoLike(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M7.4 10.6H5.2v8.2h2.2M7.4 18.8h7.4a1.8 1.8 0 0 0 1.8-1.5l.9-5.2a1.5 1.5 0 0 0-1.5-1.8h-3.4l.6-3.2a1.6 1.6 0 0 0-1.6-1.9 1.6 1.6 0 0 0-1.3.6L7.4 10.6Z" />
    </svg>
  )
}

export function IcoDislike(props: P) {
  return (
    <svg {...stroke(props)} style={{ ...props.style, transform: 'rotate(180deg)', ...{} }}>
      <path d="M7.4 10.6H5.2v8.2h2.2M7.4 18.8h7.4a1.8 1.8 0 0 0 1.8-1.5l.9-5.2a1.5 1.5 0 0 0-1.5-1.8h-3.4l.6-3.2a1.6 1.6 0 0 0-1.6-1.9 1.6 1.6 0 0 0-1.3.6L7.4 10.6Z" />
    </svg>
  )
}

export function IcoMore(props: P) {
  return (
    <svg {...base(props)}>
      <circle cx="6" cy="12" r="1.35" fill="currentColor" />
      <circle cx="12" cy="12" r="1.35" fill="currentColor" />
      <circle cx="18" cy="12" r="1.35" fill="currentColor" />
    </svg>
  )
}

export function IcoFilter(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M4.4 6.4h15.2L14 12.6v5.6l-4 1.6v-7.2L4.4 6.4Z" />
    </svg>
  )
}

export function IcoDb(props: P) {
  return (
    <svg {...stroke(props)}>
      <ellipse cx="12" cy="6.4" rx="6.6" ry="2.4" />
      <path d="M5.4 6.4v11.2c0 1.3 3 2.4 6.6 2.4s6.6-1.1 6.6-2.4V6.4" />
      <path d="M5.4 12c0 1.3 3 2.4 6.6 2.4s6.6-1.1 6.6-2.4" />
    </svg>
  )
}

export function IcoGift(props: P) {
  return (
    <svg {...stroke(props)}>
      <rect x="5" y="11" width="14" height="8.6" rx="1.4" />
      <path d="M5 11h14V8.6H5V11ZM12 8.6v11M9.2 8.6c0-2 1.2-3.4 2.8-3.4 2.4 0 2.8 3.4 0 3.4M14.8 8.6c0-2-1.2-3.4-2.8-3.4-2.4 0-2.8 3.4 0 3.4" />
    </svg>
  )
}

export function IcoWallet(props: P) {
  return (
    <svg {...stroke(props)}>
      <rect x="3.8" y="6.4" width="16.4" height="11.4" rx="2.1" />
      <path d="M16.2 12.2h3.2v3.4H16.2a1.7 1.7 0 0 1 0-3.4Z" />
    </svg>
  )
}

export function IcoCrown(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="m4.4 16.6 2.1-8.2 5.5 4.4 5.5-4.4 2.1 8.2H4.4Z" />
      <path d="M5 16.6h14v2.2a1.4 1.4 0 0 1-1.4 1.4H6.4A1.4 1.4 0 0 1 5 18.8v-2.2Z" />
    </svg>
  )
}

export function IcoPdf(props: P) {
  return (
    <svg {...base(props)} viewBox="0 0 32 32">
      <rect width="32" height="32" rx="8" fill="#E11D48" />
      <path fill="#fff" d="M9.2 21.4V10.6h5.1c2.6 0 4.1 1.4 4.1 3.5 0 2.2-1.6 3.6-4.2 3.6H11.7v3.7H9.2Zm2.5-5.7h2.2c1.2 0 1.9-.6 1.9-1.6s-.7-1.6-1.9-1.6h-2.2v3.2Z" />
    </svg>
  )
}

export function IcoSignal(props: P) {
  return (
    <svg viewBox="0 0 20 14" aria-hidden="true" {...props}>
      <rect x="0" y="9" width="3.2" height="5" rx="0.7" fill="currentColor" />
      <rect x="5.2" y="6.5" width="3.2" height="7.5" rx="0.7" fill="currentColor" />
      <rect x="10.4" y="3.6" width="3.2" height="10.4" rx="0.7" fill="currentColor" />
      <rect x="15.6" y="0.6" width="3.2" height="13.4" rx="0.7" fill="currentColor" />
    </svg>
  )
}

export function IcoWifi(props: P) {
  return (
    <svg {...stroke({ ...props, strokeWidth: 1.8 })} viewBox="0 0 24 24">
      <path d="M4.6 10A12 12 0 0 1 12 7.4c2.7 0 5.2.8 7.4 2.6" />
      <path d="M7.4 13.1A7.2 7.2 0 0 1 12 11.6c1.7 0 3.2.5 4.6 1.5" />
      <path d="M10.3 16.1a3 3 0 0 1 3.4 0" />
      <circle cx="12" cy="18.7" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IcoBattery(props: P) {
  return (
    <svg viewBox="0 0 27 13" aria-hidden="true" {...props}>
      <rect x="0.7" y="1.4" width="22.4" height="10.2" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2.6" y="3.3" width="18.6" height="6.4" rx="1" fill="currentColor" />
      <rect x="23.8" y="4.4" width="2.2" height="4.2" rx="0.7" fill="currentColor" />
    </svg>
  )
}

export function IcoFlame(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M12 20.2c3.4 0 5.8-2.2 5.8-5.4 0-2.6-1.5-4.4-3.2-6.2.2 1.8-.4 3.1-1.5 3.7C14 8.6 12.6 5.8 9.4 4c.6 2.3.1 4.2-1.2 5.6C6.6 11.3 6.2 13 6.2 14.8c0 3.2 2.4 5.4 5.8 5.4Z" />
    </svg>
  )
}

export function IcoFolder(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M4.4 8.2A1.8 1.8 0 0 1 6.2 6.4h4.2l1.8 2.2h7.6A1.8 1.8 0 0 1 21.6 10.4v8.2a1.8 1.8 0 0 1-1.8 1.8H6.2A1.8 1.8 0 0 1 4.4 18.6V8.2Z" />
    </svg>
  )
}

export function IcoBook(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M5.2 5.4h10.2A3.4 3.4 0 0 1 18.8 8.8v10.4H8.6A3.4 3.4 0 0 0 5.2 22.6V5.4Z" />
      <path d="M8.6 19.2h10.2" />
    </svg>
  )
}

export function IcoDiamond(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="m12 4.6 7.4 7.4L12 19.4 4.6 12 12 4.6Z" />
    </svg>
  )
}

export function IcoPeople(props: P) {
  return (
    <svg {...stroke(props)}>
      <circle cx="9.2" cy="8.4" r="2.4" />
      <path d="M4.6 18.2c.5-2.6 2.2-4 4.6-4s4.1 1.4 4.6 4" />
      <circle cx="16.2" cy="9" r="2" />
      <path d="M15.1 14.4c2.2.2 3.8 1.5 4.3 3.8" />
    </svg>
  )
}

export function IcoReceipt(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M7 4.4h10v15.4l-1.6-1-1.6 1-1.8-1-1.8 1-1.6-1-1.6 1V4.4Z" />
      <path d="M9.4 9h5.2M9.4 12.2h5.2" />
    </svg>
  )
}

export function IcoClock(props: P) {
  return (
    <svg {...stroke(props)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.6V12l3.2 2.2" />
    </svg>
  )
}

export function IcoInfo(props: P) {
  return (
    <svg {...stroke(props)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 10.6V17M12 7.6v.2" />
    </svg>
  )
}

export function IcoHeadset(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M5.4 13.2V12A6.6 6.6 0 0 1 18.6 12v1.2" />
      <rect x="3.8" y="12.4" width="3.4" height="5.6" rx="1.4" />
      <rect x="16.8" y="12.4" width="3.4" height="5.6" rx="1.4" />
    </svg>
  )
}

export function IcoRocket(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M14.6 4.8c2.8.8 4.6 2.6 5.4 5.4-2.6.4-4.9-.4-6.8-2.2-1.8-1.9-2.6-4.2-2.2-6.8Z" />
      <path d="m9.4 10.6-4 4.2 3.2.6.6 3.2 4.2-4" />
      <path d="M8.2 17.8 6 20.2" />
    </svg>
  )
}

export function IcoCoupon(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M4.4 8.2h15.2v3.2a2 2 0 0 0 0 3.2v3.2H4.4v-3.2a2 2 0 0 0 0-3.2V8.2Z" />
      <path d="M14.8 8.2v11.6" strokeDasharray="1.6 2" />
    </svg>
  )
}

export function IcoCard(props: P) {
  return (
    <svg {...stroke(props)}>
      <rect x="3.6" y="6.4" width="16.8" height="11.4" rx="2" />
      <path d="M3.6 10.2h16.8M7 14.4h4" />
    </svg>
  )
}

export function IcoCoins(props: P) {
  return (
    <svg {...stroke(props)}>
      <ellipse cx="10.4" cy="8.4" rx="5.4" ry="2.4" />
      <path d="M5 8.4v6.6c0 1.3 2.4 2.4 5.4 2.4s5.4-1.1 5.4-2.4V8.4" />
      <path d="M16.2 10.8c1.8.4 3.2 1.3 3.2 2.6v4c0 1.4-2 2.5-4.8 2.5" />
    </svg>
  )
}

export function IcoEdit(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M4.4 19.6H8l11-11-3.6-3.6-11 11v3.6Z" />
      <path d="m13.2 6.2 3.6 3.6" />
    </svg>
  )
}

export function IcoGear(props: P) {
  return (
    <svg {...stroke(props)}>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M12 4.4v1.8M12 17.8v1.8M4.4 12h1.8M17.8 12h1.8M6.6 6.6l1.3 1.3M16.1 16.1l1.3 1.3M17.4 6.6l-1.3 1.3M7.9 16.1l-1.3 1.3" />
    </svg>
  )
}

export function IcoSwap(props: P) {
  return (
    <svg {...stroke(props)}>
      <rect x="4.2" y="6.2" width="7.2" height="11.6" rx="1.6" />
      <rect x="12.6" y="6.2" width="7.2" height="11.6" rx="1.6" />
      <path d="M11.4 12h1.2" />
    </svg>
  )
}

export function IcoPie(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M12 4.4A7.6 7.6 0 1 0 19.6 12H12V4.4Z" />
      <path d="M13.6 4.8A7.6 7.6 0 0 1 19.2 10.4H13.6V4.8Z" />
    </svg>
  )
}

export function IcoBulb(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M8.2 10.2a3.8 3.8 0 1 1 7.6 0c0 1.8-1 2.8-1.8 3.7H10c-.8-.9-1.8-1.9-1.8-3.7Z" />
      <path d="M10 16.8h4M10.6 19h2.8" />
    </svg>
  )
}

export function IcoCheck(props: P) {
  return (
    <svg {...stroke({ ...props, strokeWidth: 2 })}>
      <path d="m6.4 12.2 3.6 3.6 7.6-8" />
    </svg>
  )
}

export function IcoFail(props: P) {
  return (
    <svg {...stroke(props)}>
      <circle cx="12" cy="12" r="8" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </svg>
  )
}

export function IcoSparkle(props: P) {
  return (
    <svg {...base(props)}>
      <path fill="currentColor" d="M8.4 4.2 9.3 7l2.8.9-2.8.9-.9 2.8-.9-2.8-2.8-.9 2.8-.9.9-2.8Zm7.4 5.2 1.1 3.2 3.2 1.1-3.2 1.1-1.1 3.2-1.1-3.2-3.2-1.1 3.2-1.1 1.1-3.2Z" />
    </svg>
  )
}

export function IcoFlow(props: P) {
  return (
    <svg {...stroke(props)}>
      <circle cx="6.4" cy="7.2" r="2.1" />
      <circle cx="17.6" cy="7.2" r="2.1" />
      <circle cx="12" cy="17" r="2.1" />
      <path d="M8.4 8.2 10.4 15M15.6 8.2 13.6 15" />
    </svg>
  )
}

export function IcoServer(props: P) {
  return (
    <svg {...stroke(props)}>
      <rect x="5" y="5.2" width="14" height="4.2" rx="1.2" />
      <rect x="5" y="10.4" width="14" height="4.2" rx="1.2" />
      <rect x="5" y="15.6" width="14" height="4.2" rx="1.2" />
      <path d="M8 7.3h.1M8 12.5h.1M8 17.7h.1" />
    </svg>
  )
}

export function IcoQr(props: P) {
  return (
    <svg {...stroke(props)}>
      <rect x="4.4" y="4.4" width="6.2" height="6.2" rx="1" />
      <rect x="13.4" y="4.4" width="6.2" height="6.2" rx="1" />
      <rect x="4.4" y="13.4" width="6.2" height="6.2" rx="1" />
      <path d="M14 14h2.4v2.4H14zM18.4 14v5.6H14" />
    </svg>
  )
}

export function IcoId(props: P) {
  return (
    <svg {...stroke(props)}>
      <rect x="4.2" y="6.4" width="15.6" height="11.2" rx="2" />
      <circle cx="9.2" cy="12" r="1.8" />
      <path d="M13 10.6h4.4M13 13.4h3.2" />
    </svg>
  )
}

export function IcoTable(props: P) {
  return (
    <svg {...stroke(props)}>
      <rect x="4.4" y="5.4" width="15.2" height="13.2" rx="1.6" />
      <path d="M4.4 9.4h15.2M4.4 13.8h15.2M9.6 9.4v9.2M14.4 9.4v9.2" />
    </svg>
  )
}

export function IcoExtract(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M8 5.4h8.4L18.8 8.8V18.6A1.4 1.4 0 0 1 17.4 20H8A1.4 1.4 0 0 1 6.6 18.6V6.8A1.4 1.4 0 0 1 8 5.4Z" />
      <path d="M9.4 12.2h5.2M9.4 15.2h3.6" />
    </svg>
  )
}

export function IcoNodes(props: P) {
  return (
    <svg {...stroke(props)}>
      <circle cx="7" cy="8" r="2.1" />
      <circle cx="17" cy="8" r="2.1" />
      <circle cx="12" cy="16.6" r="2.1" />
      <path d="M8.8 9.2 10.6 14.6M15.2 9.2 13.4 14.6M9.1 8h5.8" />
    </svg>
  )
}

export function IcoData(props: P) {
  return (
    <svg {...stroke(props)}>
      <ellipse cx="12" cy="7" rx="7" ry="2.6" />
      <path d="M5 7v10c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V7" />
    </svg>
  )
}

export function IcoN(props: P) {
  return (
    <svg {...stroke({ ...props, strokeWidth: 2.1 })}>
      <path d="M8 16.6V7.4l8 9.2V7.4" />
    </svg>
  )
}

export function IcoQuestion(props: P) {
  return (
    <svg {...stroke(props)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M9.6 9.4a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1 1-.1 1.8M12 16.8v.2" />
    </svg>
  )
}

export function IcoBox(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M4.6 8.4 12 4.8l7.4 3.6v7.2L12 19.2 4.6 15.6V8.4Z" />
      <path d="M12 19.2V11.2M4.6 8.4 12 11.2l7.4-2.8" />
    </svg>
  )
}

export function IcoList(props: P) {
  return (
    <svg {...stroke(props)}>
      <path d="M8.6 7.2h10M8.6 12h10M8.6 16.8h10M5.2 7.2h.1M5.2 12h.1M5.2 16.8h.1" />
    </svg>
  )
}

export function MarkKnot(props: P) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" {...props}>
      <rect width="48" height="48" rx="16" fill="#D7F3E5" />
      <g fill="#2F9E6A" transform="translate(24 24)">
        {[0, 60, 120, 180, 240, 300].map(deg => (
          <path
            key={deg}
            transform={`rotate(${deg})`}
            d="M0-11.2c1.9 0 3.5.7 4.7 2.1 1.5-.7 3.2-.7 4.7.1-1.2 2.2-1.3 4.7-.2 7-1.5.8-3.2.8-4.7.1C3.5 0.4 1.9 1.2 0 1.2V-11.2Z"
          />
        ))}
      </g>
    </svg>
  )
}

export function MarkBars(props: P) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" {...props}>
      <rect width="48" height="48" rx="16" fill="#FFE4C7" />
      <path stroke="#E38B2A" strokeWidth="3.4" strokeLinecap="round" d="M16 32V22M24 32V14M32 32V25" />
    </svg>
  )
}

export function MarkScale(props: P) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" {...props}>
      <rect width="48" height="48" rx="16" fill="#E4E2FF" />
      <path stroke="#5B57D6" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" d="M24 12v24M18 36h12M24 16 15 28h8L24 16l9 12h-8" />
    </svg>
  )
}

export function MarkPlay(props: P) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" {...props}>
      <rect width="48" height="48" rx="16" fill="#F8D7DE" />
      <rect x="13" y="16" width="22" height="16" rx="4" fill="none" stroke="#E23B5B" strokeWidth="2.2" />
      <path fill="#E23B5B" d="M21 20.4v7.2l7-3.6-7-3.6Z" />
    </svg>
  )
}

export function MarkTrend(props: P) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" {...props}>
      <rect width="48" height="48" rx="16" fill="#D8F4E4" />
      <path stroke="#2F9E5F" strokeWidth="2.6" strokeLinecap="round" d="m14 30 7-7 4 4 9-9" />
      <path stroke="#2F9E5F" strokeWidth="2.6" strokeLinecap="round" d="M28 18h6v6" />
    </svg>
  )
}

export function MarkCap(props: P) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" {...props}>
      <rect width="48" height="48" rx="16" fill="#D9E6FF" />
      <path stroke="#3B6DFF" strokeWidth="2.3" strokeLinejoin="round" d="m12 22 12-7 12 7-12 7-12-7Z" />
      <path stroke="#3B6DFF" strokeWidth="2.3" d="M18 25v6c3 2 9 2 12 0v-6" />
    </svg>
  )
}
