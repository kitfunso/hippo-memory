(function () {
  var svg = document.getElementById('g');
  var vb = svg.getAttribute('viewBox').split(' ').map(Number);
  var view = { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
  function apply() {
    svg.setAttribute('viewBox', view.x + ' ' + view.y + ' ' + view.w + ' ' + view.h);
  }
  var panning = false,
    sx = 0,
    sy = 0;
  svg.addEventListener('mousedown', function (e) {
    if (e.target.closest('.node')) return;
    panning = true;
    sx = e.clientX;
    sy = e.clientY;
  });
  window.addEventListener('mouseup', function () {
    panning = false;
  });
  window.addEventListener('mousemove', function (e) {
    if (!panning) return;
    var r = svg.getBoundingClientRect();
    var k = view.w / r.width;
    view.x -= (e.clientX - sx) * k;
    view.y -= (e.clientY - sy) * k;
    sx = e.clientX;
    sy = e.clientY;
    apply();
  });
  svg.addEventListener(
    'wheel',
    function (e) {
      e.preventDefault();
      var r = svg.getBoundingClientRect();
      var mx = view.x + ((e.clientX - r.left) / r.width) * view.w;
      var my = view.y + ((e.clientY - r.top) / r.height) * view.h;
      var f = e.deltaY < 0 ? 0.9 : 1.1;
      view.x = mx - (mx - view.x) * f;
      view.y = my - (my - view.y) * f;
      view.w *= f;
      view.h *= f;
      apply();
    },
    { passive: false },
  );
  var data = {};
  try {
    data = JSON.parse(document.getElementById('graph-data').textContent);
  } catch (e) {
    console.error('hippo graph: embedded model is not valid JSON', e);
  }
  var adj = {};
  (data.edges || []).forEach(function (e) {
    (adj[e.from] = adj[e.from] || []).push(e.to);
    (adj[e.to] = adj[e.to] || []).push(e.from);
  });
  var active = null;
  document.querySelectorAll('.node').forEach(function (g) {
    g.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var id = g.getAttribute('data-id');
      if (active === id) {
        clearHi();
        active = null;
        return;
      }
      active = id;
      highlight(id);
    });
  });
  svg.addEventListener('click', function () {
    clearHi();
    active = null;
  });
  function clearHi() {
    svg.classList.remove('focused');
    document.querySelectorAll('.hi').forEach(function (el) {
      el.classList.remove('hi');
    });
  }
  function highlight(id) {
    clearHi();
    svg.classList.add('focused');
    var keep = {};
    keep[id] = 1;
    (adj[id] || []).forEach(function (n) {
      keep[n] = 1;
    });
    document.querySelectorAll('.node').forEach(function (g) {
      if (keep[g.getAttribute('data-id')]) g.classList.add('hi');
    });
    document.querySelectorAll('.edge').forEach(function (l) {
      if (l.getAttribute('data-from') === id || l.getAttribute('data-to') === id) l.classList.add('hi');
    });
  }
})();
