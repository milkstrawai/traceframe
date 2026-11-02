#define _POSIX_C_SOURCE 200809L
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <sys/prctl.h>
#include <signal.h>
#include <time.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <stdint.h>

static volatile sig_atomic_t stopped;

static void stop(int signal) {
  (void)signal;
  stopped = 1;
}

static long long now(clockid_t clock) {
  struct timespec time;
  clock_gettime(clock, &time);
  return (long long)time.tv_sec * 1000000000LL + time.tv_nsec;
}

static int integer(const char *text, int minimum) {
  char *end;
  long value = strtol(text, &end, 10);
  if (!*text || *end || value < minimum || value > 32767) {
    fprintf(stderr, "Invalid capture dimension or coordinate: %s\n", text);
    exit(1);
  }
  return (int)value;
}

static int pixel(XImage *image, int x, int y, unsigned long color) {
  return XGetPixel(image, x, y) == color;
}

static int write_bytes(const void *data, size_t size) {
  const unsigned char *bytes = data;
  while (size) {
    ssize_t count = write(STDOUT_FILENO, bytes, size);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { perror("write"); return 0; }
    bytes += count;
    size -= count;
  }
  return 1;
}

static void big_endian(unsigned char *data, uint64_t value, int bytes) {
  for (int i = bytes - 1; i >= 0; i--, value >>= 8) data[i] = value & 255;
}

// A small streaming Matroska envelope carries capture PTS with the pixels.
// Raw pipes with receive-time timestamps lose time during startup/backpressure.
// Eight-byte EBML lengths keep the fixed header and frame writer straightforward.
static size_t element_header(unsigned char *data, uint32_t id, size_t size) {
  int bytes = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
  big_endian(data, id, bytes);
  big_endian(data + bytes, (uint64_t)size | (1ULL << 56), 8);
  return bytes + 8;
}

static size_t element(unsigned char *data, uint32_t id, const void *value, size_t size) {
  size_t header = element_header(data, id, size);
  memcpy(data + header, value, size);
  return header + size;
}

static size_t unsigned_element(unsigned char *data, uint32_t id, uint64_t value) {
  unsigned char bytes[8];
  big_endian(bytes, value, 8);
  return element(data, id, bytes, sizeof(bytes));
}

static int write_header(int width, int height, int rate) {
  const unsigned char ebml[] = {
    0x1a, 0x45, 0xdf, 0xa3, 0xa3, 0x42, 0x86, 0x81, 1, 0x42, 0xf7, 0x81, 1,
    0x42, 0xf2, 0x81, 4, 0x42, 0xf3, 0x81, 8, 0x42, 0x82, 0x88,
    'm', 'a', 't', 'r', 'o', 's', 'k', 'a', 0x42, 0x87, 0x81, 4, 0x42, 0x85, 0x81, 2,
    0x18, 0x53, 0x80, 0x67, 1, 255, 255, 255, 255, 255, 255, 255,
  };
  unsigned char header[1024], info[128], track[256], video[64], bitmap[40] = { 40 };
  // BITMAPINFOHEADER: top-down, 32-bit uncompressed BGR, matching XShm's layout.
  uint32_t fields[] = { (uint32_t)width, (uint32_t)-height, 0x200001, 0, (uint32_t)width * height * 4 };
  for (int i = 0; i < 5; i++) {
    for (int byte = 0; byte < 4; byte++) bitmap[4 + i * 4 + byte] = fields[i] >> (byte * 8);
  }
  size_t n = unsigned_element(info, 0x2ad7b1, 1000000); // Millisecond timecodes.
  n += element(info + n, 0x4d80, "traceframe", 10);
  n += element(info + n, 0x5741, "traceframe", 10);
  size_t total = element(header, 0x1549a966, info, n);
  n = unsigned_element(video, 0xb0, width);
  n += unsigned_element(video + n, 0xba, height);
  size_t t = unsigned_element(track, 0xd7, 1);
  t += unsigned_element(track + t, 0x73c5, 1);
  t += unsigned_element(track + t, 0x83, 1);
  t += unsigned_element(track + t, 0x23e383, 1000000000LL / rate);
  t += element(track + t, 0x86, "V_MS/VFW/FOURCC", sizeof("V_MS/VFW/FOURCC") - 1);
  t += element(track + t, 0x63a2, bitmap, sizeof(bitmap));
  t += element(track + t, 0xe0, video, n);
  unsigned char entry[512];
  n = element(entry, 0xae, track, t);
  total += element(header + total, 0x1654ae6b, entry, n);
  return write_bytes(ebml, sizeof(ebml)) && write_bytes(header, total);
}

int main(int argc, char **argv) {
  if (argc >= 3 && strcmp(argv[1], "--parent") == 0) {
    char *end;
    long parent = strtol(argv[2], &end, 10);
    if (!*argv[2] || *end || parent <= 0) return 1;
    // Also protects exec'd Xvfb/FFmpeg, without an extra supervisor process.
    // SIGKILL stops even a stalled worker. Normal shutdown still uses SIGTERM.
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) < 0) { perror("prctl"); return 1; }
    // The owner may have died before the kernel registered the death signal.
    if (getppid() != parent) return 1;
    argc -= 2;
    argv += 2;
  }
  if (argc >= 3 && strcmp(argv[1], "--exec") == 0) {
    execvp(argv[2], argv + 2);
    perror(argv[2]);
    return 1;
  }
  int locate = argc == 5 && strcmp(argv[1], "--locate") == 0;
  if (!locate && argc != 6) {
    fprintf(stderr, "Usage: grab WIDTH HEIGHT X Y FPS | grab --locate WIDTH HEIGHT SCALE\n");
    return 1;
  }
  int width = integer(argv[locate ? 2 : 1], 1);
  int height = integer(argv[locate ? 3 : 2], 1);
  int x = locate ? 0 : integer(argv[3], 0);
  int y = locate ? 0 : integer(argv[4], 0);
  int rate = integer(argv[5 - locate], 1);
  if ((!locate && rate != 30 && rate != 60) || (locate && rate != 1 && rate != 2)) return 1;

  Display *display = XOpenDisplay(NULL);
  if (!display) { fprintf(stderr, "Cannot open the private X display.\n"); return 1; }
  int screen = DefaultScreen(display);
  if (!XShmQueryExtension(display)) { fprintf(stderr, "The X display lacks MIT-SHM.\n"); XCloseDisplay(display); return 1; }
  int image_width = locate ? DisplayWidth(display, screen) : width;
  int image_height = locate ? DisplayHeight(display, screen) : height;
  XShmSegmentInfo shared = { .shmid = -1, .shmaddr = (char *)-1 };
  XImage *image = XShmCreateImage(display, DefaultVisual(display, screen), DefaultDepth(display, screen), ZPixmap, NULL, &shared, image_width, image_height);
  int result = 1, attached = 0;
  if (!image || image->bits_per_pixel != 32 || image->byte_order != LSBFirst ||
      image->red_mask != 0xff0000 || image->green_mask != 0x00ff00 || image->blue_mask != 0x0000ff ||
      image->bytes_per_line != image_width * 4) {
    fprintf(stderr, "The X display has an unsupported pixel format.\n");
    goto cleanup;
  }
  size_t size = (size_t)image->bytes_per_line * image_height;
  // Keep capture independent of FFmpeg's optional x11grab input and restrict
  // shared pixels to this user, including while the X server is attached.
  shared.shmid = shmget(IPC_PRIVATE, size, IPC_CREAT | 0600);
  if (shared.shmid < 0) { perror("shmget"); goto cleanup; }
  shared.shmaddr = shmat(shared.shmid, NULL, 0);
  // Linux permits the X server to attach after IPC_RMID. Early removal prevents
  // orphaned segments even if either process is killed during initialization.
  shmctl(shared.shmid, IPC_RMID, NULL);
  if (shared.shmaddr == (char *)-1) { perror("shmat"); goto cleanup; }
  image->data = shared.shmaddr;
  shared.readOnly = False;
  if (!XShmAttach(display, &shared)) { fprintf(stderr, "Cannot attach shared memory.\n"); goto cleanup; }
  XSync(display, False);
  attached = 1;

  struct sigaction action = { .sa_handler = stop };
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  signal(SIGPIPE, SIG_IGN);

  if (locate) {
    if (width < 4 * rate || height < 4 * rate) goto cleanup;
    long long limit = now(CLOCK_MONOTONIC) + 2000000000LL;
    // requestAnimationFrame can finish before X has presented the page's pixels.
    do {
      if (!XShmGetImage(display, DefaultRootWindow(display), image, 0, 0, AllPlanes)) goto cleanup;
      for (int top = 0; top + height <= image_height; top++) {
        for (int left = 0; left + width <= image_width; left++) {
          if (pixel(image, left, top, 0xff00ff) && pixel(image, left + 3 * rate, top, 0x00ffff) &&
              pixel(image, left + width - 1, top + height - 1, 0xffff00) &&
              pixel(image, left + width - 3 * rate, top + height - 1, 0x00ff00)) {
            printf("{\"x\":%d,\"y\":%d}\n", left, top);
            result = 0;
            goto cleanup;
          }
        }
      }
      struct timespec pause = { 0, 20000000 };
      nanosleep(&pause, NULL);
    } while (!stopped && now(CLOCK_MONOTONIC) < limit);
    fprintf(stderr, "The complete page viewport is not visible on the private display.\n");
    goto cleanup;
  }
  if (x + width > DisplayWidth(display, screen) || y + height > DisplayHeight(display, screen)) {
    fprintf(stderr, "The capture region is outside the X display.\n");
    goto cleanup;
  }
  if (!write_header(width, height, rate)) goto cleanup;
  long long next = now(CLOCK_MONOTONIC), origin = 0;
  int frames = 0;
  result = 0;
  while (!stopped) {
    struct timespec time = { next / 1000000000LL, next % 1000000000LL };
    while (clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &time, NULL) == EINTR && !stopped) {}
    if (stopped) break;
    long long timestamp = now(CLOCK_REALTIME);
    if (!frames) origin = timestamp;
    if (!XShmGetImage(display, DefaultRootWindow(display), image, x, y, AllPlanes)) {
      fprintf(stderr, "Cannot read the captured page.\n");
      result = 1;
      break;
    }
    unsigned char prefix[64];
    size_t cluster = element_header(prefix, 0x1f43b675, 0);
    size_t length = cluster + unsigned_element(prefix + cluster, 0xe7, (timestamp - origin) / 1000000);
    length += element_header(prefix + length, 0xa3, size + 4);
    memcpy(prefix + length, "\x81\0\0\x80", 4); // Track 1, relative PTS 0, keyframe.
    length += 4;
    element_header(prefix, 0x1f43b675, length - cluster + size);
    // Finish the current frame on SIGTERM; a partial frame corrupts the take.
    if (!write_bytes(prefix, length) || !write_bytes(image->data, size)) { result = 1; goto cleanup; }
    if (frames++ == 0) fprintf(stderr, "FRAME %.6f\n", timestamp / 1e6);
    next += 1000000000LL / rate;
    long long current = now(CLOCK_MONOTONIC);
    if (next < current) next = current;
  }

cleanup:
  if (attached) { XShmDetach(display, &shared); XSync(display, False); }
  if (image) { image->data = NULL; XDestroyImage(image); }
  if (shared.shmaddr != (char *)-1) shmdt(shared.shmaddr);
  XCloseDisplay(display);
  return result;
}
