<script lang="ts">
  import { links } from '../lib/content';
</script>

<footer class="border-t border-primary/15">
  <div class="mx-auto flex max-w-5xl flex-col items-center gap-4 px-5 py-10 text-center">
    <div class="flex gap-2">
      <a class="btn btn-sm btn-ghost" href={links.github} target="_blank" rel="noreferrer">GitHub</a>
      <a class="btn btn-sm btn-ghost" href={links.misskey} target="_blank" rel="noreferrer">Misskey</a>
      <a class="btn btn-sm btn-ghost" href={links.mail}>メール</a>
    </div>
    <p class="text-xs leading-relaxed opacity-60">
      3Dモデル「Museちゃん」© 2026 otoneko. — VRoid Studio で制作
      <br />
      © 2026 Museちゃん (me.muse-chan.workers.dev)
    </p>
  </div>
</footer>
