import React, { useState, useRef, useCallback, useEffect } from "react";
import { getApiBaseUrl } from "../utils/ingress";
import { debug } from "../utils/debug";
import type { ImageAttachment } from "../types";

/** Render text with @entity_id spans highlighted (color only, no width-affecting styles) */
function renderHighlightedText(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /@([a-z_]+\.[a-z0-9_]+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      <span key={match.index} className="input-entity-highlight">
        @{match[1]}
      </span>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  // Trailing newline keeps backdrop height in sync with textarea
  if (text.endsWith("\n") || text === "") parts.push("\n");
  return parts;
}

interface Entity {
  entityId: string;
  friendlyName: string | null;
  state: string;
  domain: string;
}

const DOMAIN_ICONS: Record<string, string> = {
  light: "💡",
  switch: "🔌",
  sensor: "📡",
  binary_sensor: "🔘",
  climate: "🌡️",
  cover: "🪟",
  media_player: "🎵",
  automation: "⚡",
  script: "📜",
  scene: "🎨",
  input_boolean: "🔲",
  input_number: "🔢",
  input_text: "📝",
  input_select: "📋",
  lock: "🔒",
  alarm_control_panel: "🚨",
  fan: "💨",
  camera: "📷",
  person: "👤",
  device_tracker: "📍",
  weather: "🌤️",
  zone: "📍",
};

const MAX_IMAGES = 5;
const MAX_IMAGE_DIMENSION = 1536;
const JPEG_QUALITY = 0.85;

/** Resize an image file to fit within MAX_IMAGE_DIMENSION, return as base64 JPEG */
function processImageFile(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        // Resize if either dimension exceeds max
        if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
          const scale = MAX_IMAGE_DIMENSION / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
        const base64 = dataUrl.split(",")[1];
        resolve({ mediaType: "image/jpeg", data: base64 });
      };
      img.onerror = () => reject(new Error("Failed to load image"));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

interface ChatInputProps {
  onSend: (message: string, images: ImageAttachment[]) => void;
  onCancel: () => void;
  isStreaming: boolean;
  isCancelling: boolean;
  queueDepth: number;
  disabled: boolean;
}

export function ChatInput({ onSend, onCancel, isStreaming, isCancelling, queueDepth, disabled }: ChatInputProps) {
  const [text, setText] = useState("");
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // @ mention state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState<number>(-1);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showDropdown = mentionQuery !== null && entities.length > 0;

  const fetchEntities = useCallback((query: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const url = `${getApiBaseUrl()}/api/entities?search=${encodeURIComponent(query)}`;
        debug("ui", `fetching entities query="${query}"`);
        const resp = await fetch(url);
        if (resp.ok) {
          const data: Entity[] = await resp.json();
          debug("ui", `entities fetched count=${data.length} query="${query}"`);
          setEntities(data);
          setSelectedIndex(0);
        } else {
          debug("ui", `entity fetch failed status=${resp.status}`);
        }
      } catch (err) {
        debug("ui", `entity fetch error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 150);
  }, []);

  const closeMention = useCallback(() => {
    setMentionQuery(null);
    setMentionStart(-1);
    setEntities([]);
    setSelectedIndex(0);
  }, []);

  const selectEntity = useCallback(
    (entity: Entity) => {
      debug("ui", `entity selected: ${entity.entityId}`);
      const textarea = textareaRef.current;
      if (!textarea) return;

      const cursorPos = textarea.selectionStart ?? text.length;
      const before = text.slice(0, mentionStart);
      const after = text.slice(cursorPos);
      const inserted = "@" + entity.entityId + " ";
      const newText = before + inserted + after;
      setText(newText);
      closeMention();

      // Restore focus and position cursor after inserted entity ID
      setTimeout(() => {
        if (textareaRef.current) {
          const newPos = mentionStart + inserted.length;
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(newPos, newPos);
          textareaRef.current.style.height = "auto";
          textareaRef.current.style.height =
            Math.min(textareaRef.current.scrollHeight, 200) + "px";
        }
      }, 0);
    },
    [text, mentionStart, closeMention],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newText = e.target.value;
      setText(newText);

      // Detect @ mention: find the last @ before cursor with no whitespace after it
      const cursor = e.target.selectionStart ?? newText.length;
      const textBeforeCursor = newText.slice(0, cursor);
      const atMatch = textBeforeCursor.match(/@(\S*)$/);

      if (atMatch) {
        const query = atMatch[1];
        const start = textBeforeCursor.length - atMatch[0].length;
        setMentionQuery(query);
        setMentionStart(start);
        fetchEntities(query);
      } else if (mentionQuery !== null) {
        closeMention();
      }
    },
    [mentionQuery, fetchEntities, closeMention],
  );

  const addImages = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    const remaining = MAX_IMAGES - pendingImages.length;
    if (remaining <= 0) {
      debug("ui", `image limit reached (${MAX_IMAGES}), ignoring`);
      return;
    }
    const toProcess = imageFiles.slice(0, remaining);
    debug("ui", `processing ${toProcess.length} image(s)`);
    const results = await Promise.all(toProcess.map(processImageFile));
    setPendingImages((prev) => [...prev, ...results]);
  }, [pendingImages.length]);

  const removeImage = useCallback((index: number) => {
    debug("ui", `removing image at index ${index}`);
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData.items;
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          const file = items[i].getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        addImages(imageFiles);
      }
    },
    [addImages],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      addImages(files);
    },
    [addImages],
  );

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if ((!trimmed && pendingImages.length === 0) || disabled) return;
    debug("ui", `input submitted`, { contentLength: trimmed.length, contentPreview: trimmed.substring(0, 80), imageCount: pendingImages.length });
    onSend(trimmed, pendingImages);
    setText("");
    setPendingImages([]);
    closeMention();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [text, pendingImages, disabled, onSend, closeMention]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (showDropdown) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, entities.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          selectEntity(entities[selectedIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          closeMention();
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [showDropdown, entities, selectedIndex, selectEntity, closeMention, handleSubmit],
  );

  const syncBackdrop = useCallback(() => {
    const ta = textareaRef.current;
    const bd = backdropRef.current;
    if (ta && bd) {
      bd.scrollTop = ta.scrollTop;
    }
  }, []);

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }
    syncBackdrop();
  }, [syncBackdrop]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div
      className={`chat-input${isDragOver ? " drop-active" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {showDropdown && (
        <div className="mention-dropdown">
          {entities.map((entity, i) => (
            <button
              key={entity.entityId}
              className={`mention-item${i === selectedIndex ? " selected" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault(); // Prevent textarea blur before selection
                selectEntity(entity);
              }}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span className="mention-icon">
                {DOMAIN_ICONS[entity.domain] ?? "🏠"}
              </span>
              <span className="mention-entity-id">{entity.entityId}</span>
              {entity.friendlyName && (
                <span className="mention-friendly-name">{entity.friendlyName}</span>
              )}
              <span className="mention-state">{entity.state}</span>
            </button>
          ))}
        </div>
      )}
      {pendingImages.length > 0 && (
        <div className="image-preview-strip">
          {pendingImages.map((img, i) => (
            <div key={i} className="image-preview">
              <img src={`data:${img.mediaType};base64,${img.data}`} alt={`Attachment ${i + 1}`} />
              <button className="image-preview-remove" onClick={() => removeImage(i)} title="Remove image">
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="chat-input-row">
        <div className="input-wrapper">
          <div ref={backdropRef} className="input-backdrop" aria-hidden="true">
            {renderHighlightedText(text)}
          </div>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            onScroll={syncBackdrop}
            onPaste={handlePaste}
            placeholder="Message Claude... (type @ to reference an entity)"
            rows={1}
            disabled={disabled}
          />
        </div>
        <div className="input-buttons">
          {isStreaming && (
            <button
              className={`btn-cancel${isCancelling ? " cancelling" : ""}`}
              onClick={onCancel}
              disabled={isCancelling}
            >
              {isCancelling ? "Cancelling..." : "Cancel"}
            </button>
          )}
          <button
            className="btn-send"
            onClick={handleSubmit}
            disabled={disabled || (!text.trim() && pendingImages.length === 0)}
          >
            {isStreaming && queueDepth > 0 ? `Send (${queueDepth} queued)` : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
