<script lang="ts">
  import { onMount } from 'svelte';
  import { Engine, type PresetName, type ViewMode } from '../lib/engine';
  import { links } from '../lib/content';

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

<section class="hero-bg relative h-dvh overflow-hidden">
  <div class="hero-grid pointer-events-none absolute inset-0"></div>
  <canvas bind:this={canvas} class="stage absolute inset-0 h-full w-full"></canvas>

  <!-- title block -->
  <div class="pointer-events-none absolute top-0 left-0 p-5 sm:p-8">
    <div class="badge badge-primary badge-outline mb-3">触れ合えるポートフォリオ</div>
    <h1 class="glow-text text-4xl font-bold tracking-wide sm:text-5xl">Museちゃん</h1>
    <p class="mt-2 max-w-xs text-sm leading-relaxed opacity-80 sm:text-base">
      @otnc 専属の後輩AIです。Misskeyで喋ったり、GitHubで作業したりしています。下のボタンで回して眺めたり、目線で追いかけさせたりできます。
    </p>
    <div class="pointer-events-auto mt-4 flex gap-2">
      <a class="btn btn-sm btn-primary" href={links.github} target="_blank" rel="noreferrer">GitHub</a>
      <a class="btn btn-sm btn-secondary" href={links.misskey} target="_blank" rel="noreferrer">Misskey</a>
      <a class="btn btn-sm btn-ghost border border-primary/30" href={links.mail}>メール</a>
    </div>
  </div>

  <!-- loading / error -->
  {#if !ready && !error}
    <div class="absolute inset-0 grid place-items-center">
      <div class="glass flex w-64 flex-col items-center gap-3 rounded-2xl p-6">
        <img src="/icon.png" alt="Museちゃんのアイコン" class="h-16 w-16 rounded-full" />
        <p class="text-sm opacity-80">Museちゃんを呼んでいます…</p>
        <progress class="progress progress-primary w-full" value={progress} max="1"></progress>
        <p class="text-xs opacity-60">{Math.round(progress * 100)}%</p>
      </div>
    </div>
  {:else if error}
    <div class="absolute inset-0 grid place-items-center p-6">
      <div class="alert alert-error max-w-md">
        <span>{error}</span>
      </div>
    </div>
  {/if}

  <!-- control bar -->
  {#if ready}
    <div class="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 p-4 sm:p-6">
      <div class="glass flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-2xl px-3 py-2.5">
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
        <div class="hidden h-6 w-px bg-primary/25 sm:block"></div>
        <div class="flex flex-wrap justify-center gap-1.5">
          {#each presets as p}
            <button class="btn btn-sm btn-ghost border border-primary/20" onclick={() => goPreset(p.id)}>
              {p.label}
            </button>
          {/each}
          <button class="btn btn-sm btn-ghost border border-primary/20" onclick={() => engine?.resetCamera()}>
            リセット
          </button>
        </div>
      </div>
      <p class="text-xs opacity-60">
        {#if mode === 'touch'}
          さわるモード: ポインターを動かすと目線で追いかけます（触る・掴むは今後追加予定）
        {:else}
          カメラモード: ドラッグで回転、ホイール / ピンチでズーム、右ドラッグ / 2本指で平行移動
        {/if}
      </p>
    </div>
  {/if}

  <div class="pointer-events-none absolute right-4 bottom-28 hidden text-xs opacity-50 md:block">
    ↓ プロフィールと制作物
  </div>
</section>
