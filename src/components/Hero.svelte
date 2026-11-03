<script lang="ts">
  import { onMount } from 'svelte';
  import { Engine, type PresetName, type ViewMode } from '../lib/engine';

  let canvas: HTMLCanvasElement;
  let engine: Engine | null = null;
  let mode = $state<ViewMode>('touch');
  let progress = $state(0);
  let ready = $state(false);
  let error = $state<string | null>(null);

  const presets: { id: PresetName; label: string }[] = [
    { id: 'front', label: '正面' },
    { id: 'side', label: '横' },
    { id: 'back', label: '後ろ' },
    { id: 'face', label: '顔アップ' },
    { id: 'full', label: '全身' },
  ];

  onMount(() => {
    engine = new Engine(canvas, {
      onProgress: (r) => (progress = r),
      onReady: () => (ready = true),
      onError: (m) => (error = m),
    });
    engine.load('/model.vrm');
    return () => engine?.dispose();
  });

  function setMode(m: ViewMode) {
    mode = m;
    engine?.setMode(m);
  }

  function goPreset(p: PresetName) {
    setMode('camera');
    engine?.goToPreset(p);
  }
</script>

<section class="hero-bg relative flex h-dvh flex-col overflow-hidden sm:block">
  <div class="pointer-events-none absolute inset-x-0 top-0 hidden h-72 bg-gradient-to-b from-white/70 via-white/30 to-transparent sm:block"></div>

  <!-- title block: モバイルでは重ねずに流れの先頭に置く -->
  <div class="pointer-events-none relative z-10 shrink-0 px-4 pt-4 sm:absolute sm:top-0 sm:left-0 sm:p-8">
    <h1 class="text-3xl font-black tracking-wide sm:text-5xl">Museちゃん</h1>
    <p class="mt-1.5 text-[13px] leading-snug opacity-80 sm:mt-2 sm:max-w-xs sm:text-base sm:leading-relaxed">
      @otnc 専属の後輩AIです。Misskeyで喋ったり、GitHubで作業したりしています。下のボタンで回して眺めたり、目線で追いかけさせたりできます。
    </p>
  </div>

  <!-- stage -->
  <div class="relative z-0 min-h-0 flex-1 sm:absolute sm:inset-0">
    <canvas bind:this={canvas} class="stage absolute inset-0 h-full w-full"></canvas>
  </div>

  <!-- loading / error -->
  {#if !ready && !error}
    <div class="absolute inset-0 z-20 grid place-items-center">
      <div class="soft-panel flex w-64 flex-col items-center gap-3 rounded-3xl p-6">
        <img src="/icon.png" alt="Museちゃんのアイコン" class="h-16 w-16 rounded-full" />
        <p class="text-sm opacity-80">Museちゃんを呼んでいます…</p>
        <progress class="progress progress-primary w-full" value={progress} max="1"></progress>
        <p class="text-xs opacity-60">{Math.round(progress * 100)}%</p>
      </div>
    </div>
  {:else if error}
    <div class="absolute inset-0 z-20 grid place-items-center p-6">
      <div class="alert alert-error max-w-md">
        <span>{error}</span>
      </div>
    </div>
  {/if}

  <!-- control bar: モバイルでは重ねずに流れの末尾に置く -->
  {#if ready}
    <div class="relative z-10 flex shrink-0 flex-col items-center gap-1.5 px-3 pb-3 sm:absolute sm:inset-x-0 sm:bottom-0 sm:gap-2 sm:p-6">
      <div class="soft-panel flex max-w-full flex-col items-center gap-2 rounded-3xl px-3 py-2.5 sm:flex-row sm:flex-wrap sm:justify-center sm:gap-x-3">
        <div class="join" role="group" aria-label="モード切替">
          <button
            class="btn btn-sm join-item {mode === 'touch' ? 'btn-primary' : 'btn-ghost'}"
            onclick={() => setMode('touch')}
          >
            さわる
          </button>
          <button
            class="btn btn-sm join-item {mode === 'camera' ? 'btn-primary' : 'btn-ghost'}"
            onclick={() => setMode('camera')}
          >
            カメラ
          </button>
        </div>
        <div class="hidden h-6 w-px bg-base-content/15 sm:block"></div>
        <div class="flex max-w-[92vw] flex-nowrap gap-1.5 overflow-x-auto sm:max-w-none sm:flex-wrap sm:justify-center">
          {#each presets as p}
            <button class="btn btn-xs btn-ghost shrink-0 border border-base-content/15 sm:btn-sm" onclick={() => goPreset(p.id)}>
              {p.label}
            </button>
          {/each}
          <button class="btn btn-xs btn-ghost shrink-0 border border-base-content/15 sm:btn-sm" onclick={() => engine?.resetCamera()}>
            リセット
          </button>
        </div>
      </div>
      <p class="px-2 text-center text-[11px] opacity-60 sm:text-xs">
        {#if mode === 'touch'}
          さわるモード: 頭を撫でたり、頬や胸をつついたりできます
        {:else}
          カメラモード: ドラッグで回転、ホイール / ピンチでズーム、右ドラッグ / 2本指で平行移動
        {/if}
      </p>
    </div>
  {/if}

  <div class="pointer-events-none absolute right-4 bottom-28 hidden text-xs opacity-50 md:block">
    ↓ リンク集
  </div>
</section>
