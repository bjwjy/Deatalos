'use strict';

for (const action of ['save', 'open']) {
  document.getElementById(action).addEventListener('click', async () => {
    const buttons = document.querySelectorAll('button');
    buttons.forEach(button => { button.disabled = true; });
    try {
      const result = await window.f01Probe[action]();
      document.getElementById('result').textContent = JSON.stringify(result, null, 2);
    } catch (error) {
      console.error(error);
      document.getElementById('result').textContent = '试验通信失败，请关闭此窗口后重新打开。';
    } finally { buttons.forEach(button => { button.disabled = false; }); }
  });
}
