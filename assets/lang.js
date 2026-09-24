// 按浏览器语言自动选择 简体 / 繁體 / English。
// 只在首次访问（没有记住过选择）时自动跳转；手动切换后记在本浏览器的 localStorage 里，不发送给任何人。
(function () {
  var cur = document.documentElement.getAttribute("data-locale");
  var saved = null;
  try { saved = localStorage.getItem("lang"); } catch (e) {}
  if (!saved) {
    var langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""]);
    var l = String(langs[0] || "").toLowerCase();
    var want = /^zh-(tw|hk|mo)|hant/.test(l) ? "zh-hant" : (l.indexOf("zh") === 0 ? "zh" : "en");
    try { localStorage.setItem("lang", want); } catch (e) {}
    if (want !== cur) {
      var alt = document.querySelector('link[rel="alternate"][data-locale="' + want + '"]');
      if (alt) { location.replace(alt.href + location.hash); return; }
    }
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    if (a.hasAttribute("data-setlang")) { try { localStorage.setItem("lang", a.getAttribute("data-setlang")); } catch (err) {} }
    // 在当前标签页离开本站：首页蜡烛熄灭（新标签页打开的外链不影响）
    if (a.host && a.host !== location.host && a.target !== "_blank") { try { sessionStorage.removeItem("candle-lit"); } catch (err) {} }
  });
})();
