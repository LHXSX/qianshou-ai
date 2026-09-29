function run(input) {
  if (typeof input?.text !== 'string') throw new Error('text required')
  return { count: [...input.text].length }
}
