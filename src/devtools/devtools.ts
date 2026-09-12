(function () {
  'use strict'

  chrome.devtools.panels.create(
    'Compelem',
    '../icon48.png',
    'panel/index.html',
    function (panel) {
      console.log('[Compelem DevTools] Panel created')
    }
  )

})()
