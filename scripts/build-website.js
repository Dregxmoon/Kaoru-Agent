'use strict';

const fs = require('fs/promises');
const path = require('path');
const prettier = require('prettier');

const root = path.resolve(__dirname, '../docs/web');
const languages = ['es', 'en', 'ja'];
const repo = 'https://github.com/Dregxmoon/Kaoru-Agent';
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]
  );
const commands = `git clone ${repo}.git\ncd Kaoru-Agent\nnpm install\nnpm run rebuild\nnpx electron .`;
const pagePath = (lang, page) => `${lang === 'es' ? '' : `${lang}/`}${page}.html`;

function cards(items, extra = '') {
  return items
    .map((item) => {
      const [number, title, body] = item.length === 3 ? item : ['', ...item];
      return `<article class="card fade-up ${extra}">${number ? `<span class="card-number">${escape(number)}</span>` : ''}<h3>${escape(title)}</h3><p>${escape(body)}</p></article>`;
    })
    .join('');
}

function layout(c, page, body) {
  const prefix = c.lang === 'es' ? './' : '../';
  const links = languages
    .map(
      (lang) =>
        `<a href="${prefix}${pagePath(lang, page)}" lang="${lang}" hreflang="${lang}" ${lang === c.lang ? 'aria-current="page"' : ''}>${{ es: 'Español', en: 'English', ja: '日本語' }[lang]}</a>`
    )
    .join('');
  const title = page === 'index' ? c.title : `${c.pages[page]} — Kaoru`;
  return `<!doctype html><html lang="${c.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="${escape(page === 'index' ? c.description : page === 'guide' ? c.guideIntro : c.legalIntro)}"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#f8f8f7"><title>${escape(title)}</title>
  ${languages.map((lang) => `<link rel="alternate" hreflang="${lang}" href="${prefix}${pagePath(lang, page)}">`).join('')}<link rel="alternate" hreflang="x-default" href="${prefix}${page}.html">
  <link rel="stylesheet" href="${prefix}assets/styles.css"><script src="${prefix}assets/main.js"></script></head><body>
  <a class="skip-link" href="#main">${c.skip}</a><header class="nav"><div class="nav-inner"><a class="nav-logo" href="index.html" aria-label="Kaoru"><span class="logo-mark" aria-hidden="true">k.</span>Kaoru</a>
  <nav class="nav-links" id="site-navigation" aria-label="${c.pages.index}"><a href="index.html#features">${c.nav[0]}</a><a href="index.html#workflow">${c.nav[1]}</a><a href="index.html#security">${c.nav[2]}</a><a href="guide.html" ${page === 'guide' ? 'aria-current="page"' : ''}>${c.nav[3]}</a></nav>
  <div class="nav-actions"><button class="theme-btn" id="theme-toggle" type="button" aria-label="${c.theme}" aria-pressed="false"><span aria-hidden="true">◐</span></button><button class="theme-btn menu-toggle" type="button" aria-label="${c.menu}" aria-controls="site-navigation" aria-expanded="false"><span aria-hidden="true">☰</span></button><a class="btn-dark nav-github" href="${repo}">GitHub <span aria-hidden="true">↗</span></a></div></div>
  <nav class="language-bar" aria-label="${c.language}">${links}</nav></header>
  <main id="main">${body}</main><footer><div class="container footer-top"><a class="nav-logo" href="index.html"><span class="logo-mark" aria-hidden="true">k.</span>Kaoru</a><nav aria-label="${c.pages.terms}">${Object.entries(
    c.pages
  )
    .map(
      ([key, label]) =>
        `<a href="${key}.html" ${key === page ? 'aria-current="page"' : ''}>${label}</a>`
    )
    .join(
      ''
    )}<a href="mailto:dregxmoon@gmail.com">dregxmoon@gmail.com</a></nav></div><div class="container footer-bottom"><p>${c.footer}</p><p>${c.rights}</p></div></footer></body></html>`;
}

function home(c) {
  const prefix = c.lang === 'es' ? './' : '../';
  return `<section class="hero container"><div class="badge"><span class="status-dot"></span>${c.badge}</div><h1>${c.hero}</h1><p class="hero-intro">${c.intro}</p><div class="hero-btns"><a class="btn-dark" href="guide.html">${c.start}<span aria-hidden="true">↗</span></a><a class="btn-outline" href="#features">${c.explore}<span aria-hidden="true">↓</span></a></div><p class="hero-note">${c.note}</p>
  <figure class="avatar-preview"><div class="preview-top"><span class="status-dot"></span>Kaoru <span>Live2D</span></div><img src="${prefix}assets/02-overlay-character.png" width="452" height="693" alt="${escape(c.caption)}" fetchpriority="high"><figcaption>${c.caption}</figcaption></figure></section>
  <div class="capability-strip container">${c.strip.map((x) => `<span>${x}</span>`).join('')}</div>
  <section id="features" class="section sec-alt"><div class="container"><div class="section-heading fade-up"><span class="eyebrow">01 / KAORU</span><h2>${c.featuresTitle}</h2><p>${c.featuresIntro}</p></div><div class="grid-3">${cards(c.features)}</div></div></section>
  <section id="workflow" class="section sec-dark"><div class="container"><div class="section-heading fade-up"><span class="eyebrow">02 / KAORU</span><h2>${c.flowTitle}</h2><p>${c.flowIntro}</p></div><ol class="flow-grid">${c.flow.map(([title, text], i) => `<li class="fade-up"><span class="step-number">0${i + 1}</span><h3>${title}</h3><p>${text}</p></li>`).join('')}</ol></div></section>
  <section id="security" class="section"><div class="container"><div class="section-heading fade-up"><span class="eyebrow">03 / KAORU</span><h2>${c.securityTitle}</h2><p>${c.securityIntro}</p></div><div class="grid-2">${cards(c.security, 'security-card')}</div><p class="section-link"><a href="privacy.html">${c.privacyLink} <span aria-hidden="true">↗</span></a></p></div></section>
  <section class="section sec-alt" id="users"><div class="container"><div class="section-heading fade-up"><span class="eyebrow">04 / KAORU</span><h2>${c.audienceTitle}</h2></div><div class="grid-3">${cards(c.audience)}</div></div></section>
  <section class="section" id="screenshots"><div class="container"><div class="section-heading fade-up"><h2>${c.galleryTitle}</h2><p>${c.galleryIntro}</p></div><div class="grid-2 gallery">${['03-chat-conversacion.png', '07-propuesta.png'].map((file, i) => `<figure class="fade-up"><img src="${prefix}assets/${file}" alt="${c.gallery[i]}" loading="lazy"><figcaption>${c.gallery[i]}</figcaption></figure>`).join('')}</div></div></section>
  <section class="section sec-dark" id="quickstart"><div class="container quickstart fade-up"><span class="eyebrow">KAORU / ${c.pages.guide}</span><h2>${c.quickTitle}</h2><p>${c.quickIntro}</p><ol>${c.quickSteps.map((x) => `<li>${x}</li>`).join('')}</ol><div class="hero-btns"><a class="btn-dark" href="guide.html">${c.start} <span aria-hidden="true">↗</span></a><a class="btn-outline" href="${repo}/blob/produccion/docs/README.md">${c.docs}</a></div></div></section>`;
}

function guide(c) {
  const toc = `<aside class="toc"><nav aria-label="${c.contents}"><strong>${c.contents}</strong>${c.guideSections.map(([id, title]) => `<a href="#${id}">${title}</a>`).join('')}</nav></aside>`;
  return `<header class="page-heading container"><span class="eyebrow">KAORU / ${c.pages.guide}</span><h1>${c.pages.guide}</h1><p>${c.guideIntro}</p></header><div class="container document-layout">${toc}<article class="prose">${c.guideSections.map(([id, title, text], i) => `<section id="${id}"><h2>${i + 1}. ${title}</h2><p>${text}</p>${id === 'install' ? `<div class="code-block"><div class="code-heading"><span>Git / npm</span><button type="button" class="copy-button" data-copy="install-commands" data-copied="${c.copied}" data-error="${c.copyError}">${c.copy}</button></div><pre><code id="install-commands">${escape(commands)}</code></pre></div><p class="copy-status" role="status" aria-live="polite"></p><p>${c.installNote}</p><p class="inline-links"><a href="${repo}/blob/produccion/README.md">${c.installDocs} ↗</a><a href="${repo}/blob/produccion/docs/requisitos.md">${c.requirementsLink} ↗</a><a href="${repo}/releases">${c.release} ↗</a></p>` : ''}</section>`).join('')}<p class="note"><a href="privacy.html">${c.pages.privacy}</a> · <a href="terms.html">${c.pages.terms}</a></p></article></div>`;
}

function legal(c, page, fragment) {
  const cleaned = fragment.replace(/<nav class="toc"[\s\S]*?<\/nav>/, '');
  const headings = [...cleaned.matchAll(/<h2 id="([^"]+)">([^<]+)<\/h2>/g)];
  return `<header class="page-heading container"><span class="eyebrow">KAORU / ${c.pages[page]}</span><h1>${c.pages[page]}</h1></header><div class="container document-layout"><aside class="toc"><nav aria-label="${c.contents}"><strong>${c.contents}</strong>${headings.map(([, id, title]) => `<a href="#${id}">${title}</a>`).join('')}</nav></aside><article class="prose legal">${cleaned}</article></div>`;
}

async function main() {
  let stale = false;
  for (const lang of languages) {
    const content = JSON.parse(
      await fs.readFile(path.join(root, 'content', `${lang}.json`), 'utf8')
    );
    for (const page of ['index', 'guide', 'privacy', 'terms']) {
      const body =
        page === 'index'
          ? home(content)
          : page === 'guide'
            ? guide(content)
            : legal(
                content,
                page,
                await fs.readFile(path.join(root, 'content', lang, `${page}.html`), 'utf8')
              );
      const html = await prettier.format(layout(content, page, body), {
        parser: 'html',
        printWidth: 100,
      });
      const destination = path.join(root, pagePath(lang, page));
      if (process.argv.includes('--check')) {
        const current = await fs.readFile(destination, 'utf8').catch(() => null);
        if (current !== html) {
          console.error(`Outdated: ${destination}`);
          stale = true;
        }
      } else {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, html);
      }
    }
  }
  if (stale) process.exitCode = 1;
  else console.log('Website: 12 pages, es / en / ja.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
