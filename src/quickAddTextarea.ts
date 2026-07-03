export type AutosizeTextarea = {
  scrollHeight: number;
  style: {
    height: string;
  };
};

export function resizeAutosizeTextarea(textarea: AutosizeTextarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

export function bindQuickAddTextarea(textarea: HTMLTextAreaElement) {
  resizeAutosizeTextarea(textarea);

  textarea.addEventListener("input", () => {
    resizeAutosizeTextarea(textarea);
  });

  textarea.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    textarea.form?.requestSubmit();
  });
}
