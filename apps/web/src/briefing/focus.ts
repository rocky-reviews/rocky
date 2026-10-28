/** Moves focus to the main column and scrolls it to the top (its content was just replaced). */
export const focusMain = (): void => {
  const main = document.getElementById("main");
  if (main === null) return;
  main.scrollTop = 0;
  main.focus({ preventScroll: true });
};
