/** Installed bundle delegates one exact video executor to the trusted Host. It contains no renderer or tool path. */
export const name = 'qianshou-mac-drawn-video-fixture'
export const inject = ['computeCore', 'macDrawnVideoFactory']
export function apply(ctx) {
  ctx.effect(() => ctx.computeCore.executors.register(ctx.macDrawnVideoFactory.create()),
    'qianshou-mac-drawn-video: fixed local executor')
}
