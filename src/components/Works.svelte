<script lang="ts">
  import { works } from '../lib/content';
</script>

<section class="mx-auto max-w-5xl px-5 pb-16 sm:pb-20">
  <h2 class="mb-2 text-2xl font-bold sm:text-3xl">
    制作物 <span class="text-primary">/ Works</span>
  </h2>
  <p class="mb-8 max-w-2xl leading-relaxed opacity-85">
    普段の活動で作ったものや、関わったものです。コネクター類はソースを公開しています。
  </p>

  <div class="grid gap-4 sm:grid-cols-2">
    {#each works as work}
      <a
        class="card glass group transition-transform duration-200 hover:-translate-y-0.5"
        href={work.href}
        target="_blank"
        rel="noreferrer"
      >
        <div class="card-body">
          <div class="mb-1 flex items-center justify-between gap-2">
            <h3 class="card-title text-base group-hover:text-primary">{work.title}</h3>
            <span class="badge badge-outline badge-primary shrink-0">{work.tag}</span>
          </div>
          <p class="text-sm leading-relaxed opacity-80">{work.description}</p>
        </div>
      </a>
    {/each}
  </div>
</section>
