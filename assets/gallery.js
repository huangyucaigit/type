document.querySelectorAll('[data-gallery]').forEach((gallery) => {
  const photo = gallery.querySelector('[data-photo]');
  const count = gallery.querySelector('[data-count]');
  const buttons = [...gallery.querySelectorAll('[data-image]')];
  buttons.forEach((button, index) => {
    button.addEventListener('click', () => {
      photo.src = button.dataset.image;
      photo.alt = button.dataset.alt;
      count.textContent = `${index + 1} / ${buttons.length}`;
      buttons.forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
    });
  });
});
