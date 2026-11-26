// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// Served by GitHub Pages as a project site under the account domain: https://docs.i2bskn.com/libreno/
export default defineConfig({
  site: "https://docs.i2bskn.com",
  base: "/libreno",
  devToolbar: { enabled: false },
  integrations: [
    starlight({
      title: "libreno",
      description:
        "Librenoは小さなチームのための情報共有ツールです。AIがMCPでページを書き、チームがWebで読みます。Cloudflare Workers・D1・R2で動きます。",
      defaultLocale: "root",
      locales: { root: { label: "日本語", lang: "ja" } },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/i2bskn/libreno" }],
      customCss: [
        "@fontsource/ibm-plex-sans/latin-400.css",
        "@fontsource/ibm-plex-sans/latin-500.css",
        "@fontsource/ibm-plex-sans/latin-600.css",
        "@fontsource/ibm-plex-sans-jp/400.css",
        "@fontsource/ibm-plex-sans-jp/500.css",
        "@fontsource/ibm-plex-sans-jp/600.css",
        "@fontsource/ibm-plex-mono/latin-400.css",
        "@fontsource/ibm-plex-mono/latin-500.css",
        "./src/styles/theme.css",
      ],
      components: {
        SiteTitle: "./src/components/SiteTitle.astro",
        Hero: "./src/components/Hero.astro",
        SocialIcons: "./src/components/SocialIcons.astro",
      },
      expressiveCode: {
        themes: ["github-dark-dimmed", "github-light"],
        styleOverrides: {
          borderRadius: "10px",
          borderColor: "var(--gh-line)",
          codeFontFamily: "var(--__sl-font-mono)",
          uiFontFamily: "var(--__sl-font)",
          codeFontSize: "0.8125rem",
          codeLineHeight: "1.7",
          frames: {
            shadowColor: "transparent",
            editorTabBarBackground: "var(--gh-surface-2)",
            editorActiveTabBackground: "var(--gh-surface)",
            editorActiveTabIndicatorTopColor: "var(--sl-color-accent)",
            editorActiveTabIndicatorBottomColor: "transparent",
            editorBackground: "var(--gh-surface)",
            terminalBackground: "var(--gh-surface)",
            terminalTitlebarBackground: "var(--gh-surface-2)",
          },
        },
      },
      head: [
        {
          // Copy each column header to its cells, so stacked tables on phones can label the values.
          tag: "script",
          content: `document.addEventListener("DOMContentLoaded", () => {
  for (const table of document.querySelectorAll(".sl-markdown-content table")) {
    const labels = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim());
    for (const row of table.querySelectorAll("tbody tr")) {
      [...row.children].forEach((cell, i) => {
        if (labels[i]) cell.dataset.label = labels[i];
      });
    }
  }
});`,
        },
      ],
      editLink: { baseUrl: "https://github.com/i2bskn/libreno/edit/main/docs/" },
      sidebar: [
        {
          label: "はじめに",
          items: ["getting-started/deploy", "getting-started/requirements", "getting-started/mcp"],
        },
        {
          label: "使い方",
          items: ["guides/spaces", "guides/pages", "guides/attachments", "guides/pdf"],
        },
        {
          label: "管理",
          items: ["admin/configuration", "admin/users", "admin/oidc", "admin/mfa", "admin/upgrading"],
        },
        {
          label: "開発",
          items: ["development/local"],
        },
      ],
    }),
  ],
});
