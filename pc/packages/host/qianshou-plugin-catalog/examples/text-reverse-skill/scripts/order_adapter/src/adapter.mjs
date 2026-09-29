let raw = ''
for await (const chunk of process.stdin) raw += chunk
const { text } = JSON.parse(raw)
if (typeof text !== 'string') throw new TypeError('text must be a string')
process.stdout.write(JSON.stringify({ text: [...text].reverse().join('') }))
