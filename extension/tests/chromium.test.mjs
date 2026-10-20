import assert from 'node:assert/strict';
import {access, chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium} from './chromium.mjs';

for (const terminate of ["process.exit(1)", "process.kill(process.pid,'SIGABRT')"]) {
  test(`cleanup kills a SIGTERM-ignoring group descendant after ${terminate}`, {timeout: 15000}, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xwebmcp-launcher-test-'));
    const launcher = join(directory, 'launcher');
    const pidFile = join(directory, 'descendant.pid');
    const profileFile = join(directory, 'profile');
    const previous = process.env.XWEBMCP_CHROME_BIN;
    let descendant;
    try {
      const code = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
      await writeFile(launcher, `#!${process.execPath}
const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(profileFile)},process.argv.find(arg=>arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length));
require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(code)}],{stdio:'ignore'});
const wait=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearInterval(wait);${terminate};}},10);
`);
      await chmod(launcher, 0o700);
      process.env.XWEBMCP_CHROME_BIN = launcher;
      await assert.rejects(chromium(), /Chromium exited/);
      descendant = Number(await readFile(pidFile, 'utf8'));
      let state;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const stat = await readFile(`/proc/${descendant}/stat`, 'utf8');
          state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          state = undefined;
        }
        if (state === undefined || state === 'Z' || state === 'X') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(state === undefined || state === 'Z' || state === 'X', `descendant is still live in state ${state}`);
      const profile = await readFile(profileFile, 'utf8');
      await assert.rejects(access(profile), {code: 'ENOENT'});
    } finally {
      if (!descendant) {
        try { descendant = Number(await readFile(pidFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (descendant) {
        try {
          if ((await readFile(`/proc/${descendant}/cmdline`, 'utf8')).includes(pidFile)) process.kill(descendant, 'SIGKILL');
        } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
      }
      if (previous === undefined) delete process.env.XWEBMCP_CHROME_BIN;
      else process.env.XWEBMCP_CHROME_BIN = previous;
      await rm(directory, {recursive: true, force: true});
    }
  });
}
