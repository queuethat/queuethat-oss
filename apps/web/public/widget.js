/*
 * Embeddable join widget (J7, #245). Paste on any page:
 *   <script src="https://queue.example.com/widget.js" data-location="demo-barber" async></script>
 * It adds an iframe of /w/<location> right after the script tag and sizes it to its content.
 * Optional: data-target="<element id>" puts the iframe inside that element instead.
 */
(function () {
  var script = document.currentScript;
  if (!script) return;
  var slug = script.getAttribute('data-location');
  if (!slug || !/^[A-Za-z0-9_-]+$/.test(slug)) return;
  var origin = new URL(script.src).origin;
  var frame = document.createElement('iframe');
  frame.src = origin + '/w/' + encodeURIComponent(slug);
  frame.title = 'Join the queue';
  frame.loading = 'lazy';
  frame.referrerPolicy = 'origin';
  frame.setAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox',
  );
  frame.style.cssText = 'width:100%;max-width:480px;height:480px;border:0;display:block';
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (event.source !== frame.contentWindow || event.origin !== origin) return;
    if (data && data.type === 'qm-widget-height' && typeof data.height === 'number') {
      frame.style.height = Math.min(Math.max(data.height, 120), 2000) + 'px';
    }
  });
  var targetId = script.getAttribute('data-target');
  var target = targetId ? document.getElementById(targetId) : null;
  if (target) target.appendChild(frame);
  else script.parentNode.insertBefore(frame, script.nextSibling);
})();
