import { describe, expect, it } from 'vitest'
import {
  AGENT_LIMITS,
  clampOutput,
  screenCommand,
} from './command-safety'

describe('screenCommand — blocks catastrophic commands', () => {
  const dangerous = [
    'rm -rf /',
    'rm -rf /*',
    'rm  -rf   /',
    'sudo rm -rf --no-preserve-root /',
    'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda bs=1M',
    'echo x > /dev/nvme0n1',
    'shutdown -h now',
    'sudo reboot',
    'poweroff',
    'init 0',
    ':(){ :|:& };:',
    'chown -R nobody /',
    'iptables -F',
    'ufw disable',
    'userdel -r root',
    'echo bad > /etc/passwd',
    'crontab -r',
  ]
  for (const cmd of dangerous) {
    it(`blocks: ${cmd}`, () => {
      const res = screenCommand(cmd)
      expect(res.blocked).toBe(true)
      expect(res.reason).toBeTruthy()
    })
  }

  it('blocks an empty command', () => {
    expect(screenCommand('   ').blocked).toBe(true)
  })
})

describe('screenCommand — allows normal deploy commands', () => {
  const safe = [
    'apt-get update',
    'sudo apt-get install -y nodejs npm',
    'git clone https://github.com/acme/app.git /srv/app',
    'npm ci',
    'npm run build',
    'pm2 start npm --name app -- start',
    'systemctl restart nginx',
    'rm -rf node_modules', // scoped, relative — not root
    'rm -rf /srv/app/dist', // scoped path, not bare root
    'docker compose up -d',
    'cat /etc/os-release',
    'df -h',
  ]
  for (const cmd of safe) {
    it(`allows: ${cmd}`, () => {
      expect(screenCommand(cmd).blocked).toBe(false)
    })
  }
})

describe('clampOutput', () => {
  it('returns short output unchanged', () => {
    expect(clampOutput('hello')).toBe('hello')
  })

  it('trims long output but keeps head and tail', () => {
    const big = 'A'.repeat(5000) + 'TAIL_MARKER' + 'B'.repeat(5000)
    const out = clampOutput(big, 1000)
    expect(out.length).toBeLessThan(big.length)
    expect(out.startsWith('A')).toBe(true)
    expect(out).toContain('обрезан')
  })
})

describe('AGENT_LIMITS', () => {
  it('has sane bounds', () => {
    expect(AGENT_LIMITS.maxSteps).toBeGreaterThan(0)
    expect(AGENT_LIMITS.totalMs).toBeGreaterThan(AGENT_LIMITS.perCommandMs)
    expect(AGENT_LIMITS.maxOutputChars).toBeGreaterThan(0)
  })
})
