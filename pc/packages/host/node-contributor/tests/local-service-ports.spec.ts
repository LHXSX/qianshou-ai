import { expect, it } from 'vitest'
import { parseLocalListeningPorts } from '../src/local-service-ports.ts'

it('keeps only local TCP listener ports across Windows, macOS and Linux output', () => {
  const output = [
    '  TCP    127.0.0.1:8189       0.0.0.0:0        LISTENING       1300',
    '  TCP    0.0.0.0:8794         0.0.0.0:0        LISTENING       1400',
    '  TCP    192.168.1.9:9000    0.0.0.0:0        LISTENING       1500',
    '  TCP    127.0.0.1:8188       127.0.0.1:49000 ESTABLISHED     1600',
    'python 123 user 45u IPv4 0 0t0 TCP *:8188 (LISTEN)',
    'LISTEN 0 128 [::1]:8818 [::]:*',
  ].join('\n')
  expect(parseLocalListeningPorts(output)).toEqual([8188, 8189, 8794, 8818])
})

it('rejects privileged, invalid and non-local endpoints', () => {
  expect(parseLocalListeningPorts(['TCP 127.0.0.1:80 0.0.0.0:0 LISTENING 1',
    'TCP 10.0.0.8:8188 0.0.0.0:0 LISTENING 2',
    'TCP 127.0.0.1:99999 0.0.0.0:0 LISTENING 3',
    'TCP 127.0.0.1:8188 0.0.0.0:0 TIME_WAIT 4'].join('\n'))).toEqual([])
})
