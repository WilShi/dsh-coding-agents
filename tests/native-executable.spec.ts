import { describe, expect, it } from 'vitest'
import { executableOutsideAsar } from '../src/native-executable.ts'

describe('native executable paths', () => {
  it('maps a packaged Windows executable to app.asar.unpacked', () => {
    const packed = String.raw`D:\DSH Desktop\resources\app.asar\node_modules\vendor\tool.exe`
    const unpacked = String.raw`D:\DSH Desktop\resources\app.asar.unpacked\node_modules\vendor\tool.exe`
    expect(executableOutsideAsar(packed, candidate => candidate === unpacked)).toBe(unpacked)
  })

  it('maps a packaged POSIX executable to app.asar.unpacked', () => {
    const packed = '/opt/DSH/resources/app.asar/node_modules/vendor/tool'
    const unpacked = '/opt/DSH/resources/app.asar.unpacked/node_modules/vendor/tool'
    expect(executableOutsideAsar(packed, candidate => candidate === unpacked)).toBe(unpacked)
  })

  it('keeps development and unavailable unpacked paths unchanged', () => {
    expect(executableOutsideAsar('D:\\repo\\node_modules\\vendor\\tool.exe', () => false))
      .toBe('D:\\repo\\node_modules\\vendor\\tool.exe')
    expect(executableOutsideAsar(String.raw`D:\app.asar\tool.exe`, () => false))
      .toBe(String.raw`D:\app.asar\tool.exe`)
  })
})
