<script lang="ts">
  import { onMount } from 'svelte';
  import { fly, fade, scale } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { backOut, cubicOut } from 'svelte/easing';
  import { Tween } from 'svelte/motion';
  import { listen } from '@tauri-apps/api/event';
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { Flask, Hex, Spark, fit, heatColor, memPct, quip, type Layer, type Sample } from './lib/engine';
  import { LedLayer, ledText } from './lib/led';
  import { Bot } from './lib/bot3d';

  type Prefs = { docked: boolean; locked: boolean; clickThrough: boolean };
  type PrefKey = 'docked' | 'locked' | 'click_through';

  let sample = $state<Sample | null>(null);
  let prefs = $state<Prefs>({ docked: false, locked: false, clickThrough: false });
  let tab = $state<'cpu' | 'mem'>('cpu');
  let bubble = $state<{ id: number; text: string } | null>(null);
  let reply = $state<{ id: number; text: string; bad: boolean } | null>(null);
  let armed = $state<number | null>(null);
  let tipBox = $state<{ text: string; x: number; y: number; below: boolean } | null>(null);

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ms = (n: number) => (reduced ? 0 : n);
  const memGb = new Tween(0, { duration: 700, easing: cubicOut });

  let cvGL: HTMLCanvasElement, cvDaemon: HTMLCanvasElement, cvFlask: HTMLCanvasElement, cvHex: HTMLCanvasElement, cvSpark: HTMLCanvasElement;
  let bot: Bot | null = null;
  const flask = new Flask(), hex = new Hex(), spark = new Spark();

  // Glass screens: visualiser on the right, LED digits on the left (digits ease toward the live value).
  const cpuScreen = new LedLayer(flask, 4, 0.42), memScreen = new LedLayer(hex, 4, 0.42), heatScreen = new LedLayer(spark, 4);
  const shown = { cpu: 0, mem: 0, heat: 0 };
  const ease = (k: keyof typeof shown, v: number) => (shown[k] += (v - shown[k]) * 0.18);
  cpuScreen.overlay = (g) => sample && ledText(g, `${Math.round(ease('cpu', sample.cpu))}%`, 1, 1, heatColor(sample.cpu));
  memScreen.overlay = (g) => sample && ledText(g, `${Math.round(ease('mem', memPct(sample)))}%`, 1, 1, heatColor(memPct(sample)));
  heatScreen.overlay = (g) => {
    if (!sample) return;
    const isTemp = sample.temp != null, v = ease('heat', sample.temp ?? sample.cpu);
    const text = `${Math.round(v)}${isTemp ? '°' : '%'}`;
    g.clearRect(0, 0, text.length * 4 + 1, 7);
    ledText(g, text, 1, 1, heatColor(isTemp ? (v - 30) * 1.4 : v));
  };

  const procs = $derived(sample ? (tab === 'cpu' ? sample.topCpu : sample.topMem) : []);
  const fmtMem = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${(b / 1024 ** 2).toFixed(0)} MB`);
  let seq = 0;

  /** Custom tooltip: a small glass label after a short hover, also on keyboard focus. */
  function tip(node: HTMLElement, text: string) {
    let label = text, timer = 0;
    const show = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const r = node.getBoundingClientRect(), below = r.top < 48;
        tipBox = { text: label, x: Math.min(Math.max(r.left + r.width / 2, 70), innerWidth - 70), y: below ? r.bottom + 8 : r.top - 8, below };
      }, 420);
    };
    const hide = () => {
      clearTimeout(timer);
      tipBox = null;
    };
    const evs = [['pointerenter', show], ['pointerleave', hide], ['pointerdown', hide], ['focus', show], ['blur', hide]] as const;
    evs.forEach(([e, f]) => node.addEventListener(e, f));
    return {
      update: (t: string) => (label = t),
      destroy: () => (hide(), evs.forEach(([e, f]) => node.removeEventListener(e, f))),
    };
  }

  function say(text: string, bad = false) {
    const id = ++seq;
    reply = { id, text, bad };
    setTimeout(() => reply?.id === id && (reply = null), 3500);
  }

  async function setPref(key: PrefKey, on: boolean) {
    try {
      prefs = await invoke<Prefs>('set_pref', { key, on });
      if (key === 'click_through' && on) say('Clicks now pass through. Turn this off from the menu bar icon.');
    } catch (e) {
      say(`Couldn't change that setting: ${e}`, true);
    }
  }

  async function quit(pid: number, name: string) {
    if (armed !== pid) {
      armed = pid; // two-step confirm instead of a blocking dialog
      setTimeout(() => armed === pid && (armed = null), 3000);
      return;
    }
    armed = null;
    try {
      await invoke('kill_process', { pid });
      say(`Quit ${name}`);
    } catch (e) {
      say(`Couldn't quit ${name}: ${e}`, true);
    }
  }

  const reveal = (path: string) => invoke('reveal_path', { path }).catch((e) => say(`Couldn't show it in the file manager: ${e}`, true));

  function local(cv: HTMLCanvasElement, e: MouseEvent) {
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function poke(e: MouseEvent) {
    const p = local(cvDaemon, e);
    if (!bot?.hit(p.x, p.y)) return;
    say_(quip(sample, bot.mood, bot.poke()));
  }

  function backflip(e: MouseEvent) {
    const p = local(cvDaemon, e);
    if (!bot?.hit(p.x, p.y)) return;
    bot.flip();
    say_(quip(sample, bot.mood, 'flip'));
  }

  /** Speech bubble above the bot; empty text = no bubble. */
  function say_(text: string) {
    if (!text) return;
    const id = ++seq;
    bubble = { id, text };
    setTimeout(() => bubble?.id === id && (bubble = null), 3400);
  }

  function drag(e: MouseEvent) {
    if (prefs.locked || e.button !== 0 || (e.target as Element).closest('button')) return;
    getCurrentWindow().startDragging();
  }

  onMount(() => {
    const b = (bot = new Bot(cvGL));
    const layers: { ctx: CanvasRenderingContext2D; w: number; h: number; g: Layer }[] = (
      [
        [cvDaemon, b],
        [cvFlask, cpuScreen],
        [cvHex, memScreen],
        [cvSpark, heatScreen],
      ] as const
    ).map(([cv, g]) => ({ ...fit(cv), g }));

    // 30 fps cap: measured 60 fps cost ~40% of a core in WebKit's GPU process — too much for an always-on widget.
    let raf = 0, last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < 1000 / 30 - 2) return;
      const dt = Math.min(Math.max(now - last, 0) / 1000, 0.05);
      last = now;
      for (const l of layers) {
        l.ctx.clearRect(0, 0, l.w, l.h);
        l.g.draw(l.ctx, l.w, l.h, now / 1000, dt);
      }
    };
    raf = requestAnimationFrame(frame);

    const move = (e: PointerEvent) => b.pointer(local(cvDaemon, e));
    const leave = () => b.pointer(null);
    window.addEventListener('pointermove', move);
    document.documentElement.addEventListener('mouseleave', leave);

    // Alerts are shown by the notch island; this window only replies to its own actions.
    const unlisten = [
      listen<Sample>('telemetry', ({ payload: s }) => {
        sample = s;
        memGb.target = s.memUsed / 1024 ** 3;
        b.setSample(s);
        flask.set(s.cpu);
        hex.set(memPct(s));
        spark.push(s.temp ?? s.cpu, s.temp != null);
      }),
      listen<Prefs>('prefs', ({ payload }) => {
        prefs = payload;
        try {
          localStorage.setItem('cp-prefs', JSON.stringify({ docked: payload.docked, locked: payload.locked }));
        } catch {}
      }),
    ];

    // Restore persisted prefs (click-through deliberately never persists).
    try {
      const saved = JSON.parse(localStorage.getItem('cp-prefs') ?? '{}');
      if (saved.docked) setPref('docked', true);
      if (saved.locked) setPref('locked', true);
    } catch {}

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('mouseleave', leave);
      unlisten.forEach((p) => p.then((off) => off()));
    };
  });
</script>

<main class="shell" class:ghost={prefs.clickThrough}>
  <header class="flex items-center justify-between pt-3.5 {prefs.locked ? '' : 'cursor-grab active:cursor-grabbing'}" onmousedown={drag} role="toolbar" tabindex="-1">
    <h1 class="wordmark m-0 pl-1" style:--tone={sample ? heatColor(sample.cpu) : undefined}><span class="pulse"></span>Puco</h1>
    <div class="flex items-center gap-2">
      <div class="rail">
        <button class="key" aria-pressed={prefs.locked} aria-label="Lock position" use:tip={prefs.locked ? 'Unlock to drag it around' : 'Lock it in place'} onclick={() => setPref('locked', !prefs.locked)}>
          <svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg><span class="led"></span>
        </button>
        <button class="key" aria-pressed={prefs.docked} aria-label="Open from the menu bar" use:tip={prefs.docked ? 'Float on the desktop instead' : 'Open from the menu bar instead'} onclick={() => setPref('docked', !prefs.docked)}>
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="4" rx="1" /><rect x="11" y="10" width="9" height="10" rx="2" /></svg><span class="led"></span>
        </button>
        <button class="key" aria-pressed={prefs.clickThrough} aria-label="Let clicks pass through" use:tip={'Let clicks pass through'} onclick={() => setPref('click_through', true)}>
          <svg viewBox="0 0 24 24"><path d="M5 20V10a7 7 0 0 1 14 0v10l-2.3-2-2.3 2-2.4-2-2.4 2-2.3-2z" /><path d="M9.5 10.5h.01M14.5 10.5h.01" /></svg><span class="led"></span>
        </button>
      </div>
      <button class="key" aria-label="Hide" use:tip={'Hide (bring it back from the menu bar)'} onclick={() => getCurrentWindow().hide()}>
        <svg viewBox="0 0 24 24"><path d="M6 12h12" /></svg>
      </button>
    </div>
  </header>

  <!-- the robot: WebGL scene + 2D particle/hit layer -->
  <section class="stage relative -mx-4 h-[156px] shrink-0">
    {#if bubble}
      {#key bubble.id}<div class="bubble" transition:scale={{ start: 0.6, duration: ms(320), easing: backOut }}>{bubble.text}</div>{/key}
    {/if}
    <canvas bind:this={cvGL} class="absolute inset-0 h-full w-full"></canvas>
    <canvas bind:this={cvDaemon} class="absolute inset-0 h-full w-full cursor-pointer" onclick={poke} ondblclick={backflip} aria-label="Puco robot. Click to poke it, double-click for a flip, stroke it to pet it."></canvas>
  </section>

  <section class="grid grid-cols-2 gap-4">
    <div>
      <div class="glass h-[84px]" use:tip={'How hard the processor is working'}><canvas bind:this={cvFlask} style:--d="0.15s"></canvas></div>
      <div class="engraved mt-2 px-1">Processor</div>
    </div>
    <div>
      <div class="glass h-[84px]" use:tip={'Memory in use right now'}><canvas bind:this={cvHex} style:--d="0.3s"></canvas></div>
      <div class="engraved mt-2 flex justify-between px-1">Memory{#if sample}<b>{memGb.current.toFixed(1)} / {(sample.memTotal / 1024 ** 3).toFixed(0)} GB</b>{/if}</div>
    </div>
  </section>

  <section class="mt-4">
    <div class="glass h-[48px]" use:tip={sample && sample.temp == null ? 'No temperature sensor here, so this shows load' : 'Hottest sensor over the last minute'}>
      <canvas bind:this={cvSpark} style:--d="0.45s"></canvas>
    </div>
    <div class="engraved mt-2 flex justify-between px-1">
      {sample && sample.temp == null ? 'Load' : 'Temperature'}
      {#if sample?.battery}
        <b class:text-hot={sample.battery.pct < 20 && !sample.battery.charging}>{sample.battery.charging ? 'charging' : 'battery'} {sample.battery.pct.toFixed(0)}%</b>
      {/if}
    </div>
  </section>

  <section class="mt-4 flex min-h-0 flex-1 flex-col">
    <div class="mb-2 flex items-center justify-between">
      <span class="engraved px-1">Busiest right now</span>
      <div class="rail" role="tablist" aria-label="Rank by">
        <button class="key" role="tab" aria-selected={tab === 'cpu'} onclick={() => (tab = 'cpu')}>CPU<span class="led"></span></button>
        <button class="key" role="tab" aria-selected={tab === 'mem'} onclick={() => (tab = 'mem')}>Memory<span class="led"></span></button>
      </div>
    </div>
    <div class="glass">
      <ul class="tasks" style:--d="0.6s">
        {#each procs as p (p.pid)}
          {@const share = tab === 'cpu' ? p.cpu : (p.mem / (sample?.memTotal || 1)) * 100}
          <li class="task" style:--tone={heatColor(tab === 'cpu' ? p.cpu * 2 : share * 3)} animate:flip={{ duration: ms(380), easing: cubicOut }} in:fly={{ y: 8, duration: ms(260), easing: cubicOut }} out:fade={{ duration: ms(120) }}>
            <div class="min-w-0">
              <div class="name" use:tip={`${p.name} (process ${p.pid})`}>{p.name}</div>
              <div class="meter"><i style:width="{Math.max(3, Math.min(100, share * (tab === 'cpu' ? 1 : 2)))}%"></i></div>
            </div>
            <span class="val">{tab === 'cpu' ? `${p.cpu.toFixed(1)}%` : fmtMem(p.mem)}</span>
            <button class="gbtn" aria-label="Show {p.name} in the file manager" use:tip={'Show in file manager'} disabled={!p.exe} onclick={() => p.exe && reveal(p.exe)}>
              <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6" /><path d="m20 20-4.3-4.3" /></svg>
            </button>
            <button class="gbtn" class:armed={armed === p.pid} aria-label="Quit {p.name}" use:tip={armed === p.pid ? 'Click again to quit' : 'Quit'} onclick={() => quit(p.pid, p.name)}>
              {#if armed === p.pid}quit?{:else}<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17" /></svg>{/if}
            </button>
          </li>
        {:else}
          <li class="task"><span class="name cursor">scanning processes</span></li>
        {/each}
      </ul>
    </div>
  </section>

  {#if reply}
    {#key reply.id}
      <div class="reply" class:bad={reply.bad} role="status" transition:fly={{ y: 14, duration: ms(260), easing: cubicOut }}>{reply.text}</div>
    {/key}
  {/if}

  {#if tipBox}
    <div class="tip" class:below={tipBox.below} style:left="{tipBox.x}px" style:top="{tipBox.y}px" transition:fade={{ duration: ms(120) }}>{tipBox.text}</div>
  {/if}
</main>
