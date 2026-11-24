#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreImage/CoreImage.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <numeric>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#if SLWV_NDI_AVAILABLE
#include <Processing.NDI.Lib.h>
#endif

namespace {
constexpr size_t protocolLineLimit = 64 * 1024;
constexpr int mediaTimescale = 1000000;
constexpr int fpsDenominator = 1000000;
std::mutex outputMutex;
std::atomic<bool> stopping{false};

double hostNow() { return CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())); }
std::string utf8(NSString *value) { return value ? std::string(value.UTF8String ?: "") : std::string(); }
NSString *ns(const std::string &value) { return [NSString stringWithUTF8String:value.c_str()]; }
void emit(NSDictionary *message) {
  @autoreleasepool {
    NSData *data = [NSJSONSerialization dataWithJSONObject:message options:0 error:nil];
    if (!data) return;
    std::lock_guard<std::mutex> guard(outputMutex);
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
  }
}
[[noreturn]] void invalid(const char *name) { throw std::runtime_error(std::string("Invalid ") + name); }
double number(NSDictionary *object, NSString *key) {
  id value = object[key];
  if (![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID() || !std::isfinite([value doubleValue])) invalid(key.UTF8String);
  return [value doubleValue];
}
bool boolean(NSDictionary *object, NSString *key) {
  id value = object[key];
  if (![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID()) invalid(key.UTF8String);
  return [value boolValue];
}
std::string stringValue(NSDictionary *object, NSString *key) {
  if (![object[key] isKindOfClass:NSString.class]) invalid(key.UTF8String);
  return utf8(object[key]);
}
double positive(NSDictionary *object, NSString *key) {
  double result = number(object, key);
  if (result <= 0) invalid(key.UTF8String);
  return result;
}

struct Settings {
  double stateTimeoutSec;
  double loadTimeoutSec;
  double seekThresholdSec;
  double maxFramePixels;
  double maxOutputFps;
  size_t maxDecodeFramesPerTick;
  double timerLeewaySec;
};
Settings settingsFrom(NSDictionary *object) {
  if (![object isKindOfClass:NSDictionary.class]) invalid("settings");
  double decodeLimit = positive(object, @"maxDecodeFramesPerTick");
  if (decodeLimit != std::floor(decodeLimit) || decodeLimit > protocolLineLimit) invalid("maxDecodeFramesPerTick");
  double leeway = number(object, @"timerLeewayMs");
  if (leeway < 0) invalid("timerLeewayMs");
  return {positive(object, @"stateTimeoutMs") / 1000, positive(object, @"loadTimeoutMs") / 1000,
    positive(object, @"seekThresholdSec"), positive(object, @"maxFramePixels"),
    positive(object, @"maxOutputFps"), static_cast<size_t>(decodeLimit), leeway / 1000};
}
struct State {
  std::string generation;
  std::string path;
  double position = 0;
  double rate = 1;
  double hostTime = 0;
  double receivedAt = 0;
  bool playing = false;
};
double projected(const State &state, double now) {
  return state.position + (state.playing ? std::max(0.0, now - state.hostTime) * state.rate : 0);
}
struct FrameRate { int numerator; int denominator; double value() const { return double(numerator) / denominator; } };
FrameRate frameRate(double fps) {
  if (!std::isfinite(fps) || fps <= 0 || fps * fpsDenominator > INT_MAX) throw std::runtime_error("Unsupported video frame rate");
  int numerator = std::max(1, int(std::llround(fps * fpsDenominator)));
  int divisor = std::gcd(numerator, fpsDenominator);
  return {numerator / divisor, fpsDenominator / divisor};
}

class Ndi {
#if SLWV_NDI_AVAILABLE
  void *library = nullptr;
  decltype(&NDIlib_initialize) initialize = nullptr;
  decltype(&NDIlib_destroy) destroy = nullptr;
  decltype(&NDIlib_send_create) create = nullptr;
  decltype(&NDIlib_send_destroy) destroySender = nullptr;
  decltype(&NDIlib_send_send_video_v2) sendVideo = nullptr;
  template<typename T> T symbol(const char *name) {
    auto result = reinterpret_cast<T>(dlsym(library, name));
    if (!result) throw std::runtime_error(std::string("NDI runtime lacks ") + name);
    return result;
  }
#endif
public:
  explicit Ndi(bool testMode): test(testMode) {
    if (test) return;
#if SLWV_NDI_AVAILABLE
    std::vector<std::string> paths;
    const char *explicitPath = std::getenv("NDI_RUNTIME_LIBRARY");
    if (explicitPath && *explicitPath) paths.emplace_back(explicitPath);
    else {
      for (const char *env : {"NDI_RUNTIME_DIR_V6", "NDI_RUNTIME_DIR_V5"}) {
        const char *value = std::getenv(env);
        if (value && *value) paths.emplace_back(std::string(value) + "/libndi.dylib");
      }
#ifdef SLWV_NDI_DEFAULT_RUNTIME
      paths.emplace_back(SLWV_NDI_DEFAULT_RUNTIME);
#endif
      paths.emplace_back("/usr/local/lib/libndi.dylib");
      paths.emplace_back("/Library/NDI SDK for Apple/lib/macOS/libndi.dylib");
    }
    for (const auto &path : paths) { library = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL); if (library) break; }
    if (!library) throw std::runtime_error("NDI runtime unavailable. Set NDI_RUNTIME_LIBRARY to the official libndi.dylib.");
    try {
      initialize = symbol<decltype(initialize)>("NDIlib_initialize");
      destroy = symbol<decltype(destroy)>("NDIlib_destroy");
      create = symbol<decltype(create)>("NDIlib_send_create");
      destroySender = symbol<decltype(destroySender)>("NDIlib_send_destroy");
      sendVideo = symbol<decltype(sendVideo)>("NDIlib_send_send_video_v2");
      if (!initialize()) throw std::runtime_error("NDI runtime initialization failed");
    } catch (...) { dlclose(library); library = nullptr; throw; }
#else
    throw std::runtime_error("Helper built without the NDI SDK. Set NDI_SDK_DIR to your official SDK and run npm run build:video.");
#endif
  }
  ~Ndi() {
#if SLWV_NDI_AVAILABLE
    if (library) { destroy(); dlclose(library); }
#endif
  }
  void *sender(const std::string &name) {
    if (test) return nullptr;
#if SLWV_NDI_AVAILABLE
    NDIlib_send_create_t options{};
    options.p_ndi_name = name.c_str();
    options.p_groups = nullptr;
    options.clock_video = false;
    options.clock_audio = false;
    auto result = create(&options);
    if (!result) throw std::runtime_error("Cannot create NDI sender: " + name);
    return result;
#else
    (void)name; return nullptr;
#endif
  }
  void closeSender(void *sender) {
#if SLWV_NDI_AVAILABLE
    if (sender) destroySender(static_cast<NDIlib_send_instance_t>(sender));
#else
    (void)sender;
#endif
  }
  void send(void *sender, CVPixelBufferRef pixels, FrameRate fps) {
    if (test) return;
#if SLWV_NDI_AVAILABLE
    CVPixelBufferLockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly);
    NDIlib_video_frame_v2_t frame{};
    frame.xres = int(CVPixelBufferGetWidth(pixels));
    frame.yres = int(CVPixelBufferGetHeight(pixels));
    frame.FourCC = NDIlib_FourCC_type_BGRX;
    frame.frame_rate_N = fps.numerator;
    frame.frame_rate_D = fps.denominator;
    frame.picture_aspect_ratio = float(frame.xres) / frame.yres;
    frame.frame_format_type = NDIlib_frame_format_type_progressive;
    frame.timecode = NDIlib_send_timecode_synthesize;
    frame.p_data = static_cast<uint8_t *>(CVPixelBufferGetBaseAddress(pixels));
    frame.line_stride_in_bytes = int(CVPixelBufferGetBytesPerRow(pixels));
    frame.p_metadata = nullptr;
    sendVideo(static_cast<NDIlib_send_instance_t>(sender), &frame);
    CVPixelBufferUnlockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly);
#else
    (void)sender; (void)pixels; (void)fps;
#endif
  }
  bool test;
};

struct Loaded {
  AVURLAsset *__strong asset = nil;
  AVAssetTrack *__strong track = nil;
  double duration = 0;
  double start = 0;
  double fps = 0;
  CGAffineTransform transform = CGAffineTransformIdentity;
  CGRect bounds = CGRectZero;
  std::string error;
};
using LoadCallback = std::function<void(Loaded)>;
void loadVideo(AVURLAsset *asset, LoadCallback callback) {
  [asset loadValuesAsynchronouslyForKeys:@[@"tracks", @"duration", @"playable"] completionHandler:^{
    @autoreleasepool {
      Loaded result; result.asset = asset;
      for (NSString *key in @[@"tracks", @"duration", @"playable"]) {
        NSError *error = nil;
        if ([asset statusOfValueForKey:key error:&error] != AVKeyValueStatusLoaded) {
          result.error = utf8(error.localizedDescription ?: @"Video metadata load failed"); callback(result); return;
        }
      }
      AVAssetTrack *track = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
      if (!asset.playable || !track) { result.error = "No playable video track"; callback(result); return; }
      result.track = track;
      [track loadValuesAsynchronouslyForKeys:@[@"naturalSize", @"preferredTransform", @"nominalFrameRate", @"minFrameDuration", @"timeRange"] completionHandler:^{
        @autoreleasepool {
          Loaded loaded = result;
          for (NSString *key in @[@"naturalSize", @"preferredTransform", @"nominalFrameRate", @"minFrameDuration", @"timeRange"]) {
            NSError *error = nil;
            if ([track statusOfValueForKey:key error:&error] != AVKeyValueStatusLoaded) {
              loaded.error = utf8(error.localizedDescription ?: @"Video track metadata load failed"); callback(loaded); return;
            }
          }
          loaded.transform = track.preferredTransform;
          loaded.start = CMTimeGetSeconds(track.timeRange.start);
          loaded.duration = CMTimeGetSeconds(CMTimeRangeGetEnd(track.timeRange));
          loaded.bounds = CGRectApplyAffineTransform(CGRectMake(0, 0, track.naturalSize.width, track.naturalSize.height), loaded.transform);
          double frameDuration = CMTimeGetSeconds(track.minFrameDuration);
          loaded.fps = std::isfinite(frameDuration) && frameDuration > 0 ? 1 / frameDuration : track.nominalFrameRate;
          if (!std::isfinite(loaded.start) || !std::isfinite(loaded.duration) || loaded.duration <= loaded.start || !std::isfinite(loaded.fps) || loaded.fps <= 0 ||
              !std::isfinite(loaded.bounds.size.width) || !std::isfinite(loaded.bounds.size.height) ||
              loaded.bounds.size.width <= 0 || loaded.bounds.size.height <= 0) loaded.error = "Unsupported video dimensions, duration or frame rate";
          callback(loaded);
        }
      }];
    }
  }];
}

class Decoder {
  AVAssetReader *__strong reader = nil;
  AVAssetReaderTrackOutput *__strong output = nil;
  CMSampleBufferRef next = nullptr;
  CVPixelBufferRef current = nullptr;
  double currentTime = -INFINITY;
  double currentEnd = -INFINITY;
  double nextTime = INFINITY;
public:
  Loaded source;
  size_t seeks = 0;
  explicit Decoder(Loaded source): source(std::move(source)) {}
  ~Decoder() { reset(); }
  void reset() {
    [reader cancelReading]; reader = nil; output = nil;
    if (next) { CFRelease(next); next = nullptr; }
    if (current) { CVPixelBufferRelease(current); current = nullptr; }
    currentTime = -INFINITY; currentEnd = -INFINITY; nextTime = INFINITY;
  }
  void seek(double target) {
    seeks++;
    reset();
    NSError *error = nil;
    reader = [[AVAssetReader alloc] initWithAsset:source.asset error:&error];
    if (!reader) throw std::runtime_error(utf8(error.localizedDescription));
    output = [[AVAssetReaderTrackOutput alloc] initWithTrack:source.track outputSettings:@{(id)kCVPixelBufferPixelFormatTypeKey:@(kCVPixelFormatType_32BGRA)}];
    output.alwaysCopiesSampleData = NO;
    if (![reader canAddOutput:output]) throw std::runtime_error("Cannot decode video track");
    [reader addOutput:output];
    double start = std::max(source.start, target - 1 / source.fps);
    reader.timeRange = CMTimeRangeMake(CMTimeMakeWithSeconds(start, mediaTimescale), CMTimeMakeWithSeconds(source.duration - start, mediaTimescale));
    if (![reader startReading]) throw std::runtime_error(utf8(reader.error.localizedDescription ?: @"Video decoder failed to start"));
    readNext();
  }
  void readNext() {
    if (next) { CFRelease(next); next = nullptr; }
    next = [output copyNextSampleBuffer];
    if (!next) {
      nextTime = INFINITY;
      if (reader.status == AVAssetReaderStatusFailed) throw std::runtime_error(utf8(reader.error.localizedDescription ?: @"Video decoding failed"));
      return;
    }
    nextTime = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(next));
    if (!std::isfinite(nextTime)) throw std::runtime_error("Video frame lacks a valid timestamp");
  }
  CVPixelBufferRef frame(double target, const Settings &settings) {
    if (!reader || target < currentTime - 1 / source.fps ||
        (std::isfinite(nextTime) && target > nextTime + settings.seekThresholdSec)) seek(target);
    size_t decoded = 0;
    while (next && (nextTime <= target || !current)) {
      if (++decoded > settings.maxDecodeFramesPerTick) return nullptr;
      if (current) CVPixelBufferRelease(current);
      current = CMSampleBufferGetImageBuffer(next);
      if (!current) throw std::runtime_error("Decoded frame has no image buffer");
      CVPixelBufferRetain(current);
      currentTime = nextTime;
      double duration = CMTimeGetSeconds(CMSampleBufferGetDuration(next));
      currentEnd = currentTime + (std::isfinite(duration) && duration > 0 ? duration : 1 / source.fps);
      readNext();
    }
    return !next && target >= currentEnd ? nullptr : current;
  }
  double position() const { return currentTime; }
};

class Canvas {
  CIContext *__strong context = [CIContext contextWithOptions:@{kCIContextCacheIntermediates:@NO}];
  CVPixelBufferRef pixels = nullptr;
  CGColorSpaceRef colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  int width = 0, height = 0;
public:
  ~Canvas() { if (pixels) CVPixelBufferRelease(pixels); CGColorSpaceRelease(colorSpace); }
  CVPixelBufferRef render(CVPixelBufferRef input, const Loaded *source, int w, int h) {
    if (!pixels || w != width || h != height) {
      if (pixels) CVPixelBufferRelease(pixels); pixels = nullptr;
      NSDictionary *options = @{(id)kCVPixelBufferIOSurfacePropertiesKey:@{}, (id)kCVPixelBufferMetalCompatibilityKey:@YES};
      if (CVPixelBufferCreate(kCFAllocatorDefault, w, h, kCVPixelFormatType_32BGRA, (__bridge CFDictionaryRef)options, &pixels) != kCVReturnSuccess) throw std::runtime_error("Cannot allocate output video frame");
      width = w; height = h;
    }
    CGRect bounds = CGRectMake(0, 0, w, h);
    CIImage *image = [[CIImage imageWithColor:[CIColor colorWithRed:0 green:0 blue:0 alpha:1]] imageByCroppingToRect:bounds];
    if (input && source) {
      CIImage *video = [[CIImage imageWithCVPixelBuffer:input] imageByApplyingTransform:source->transform];
      CGRect extent = video.extent;
      video = [video imageByApplyingTransform:CGAffineTransformMakeTranslation(-extent.origin.x, -extent.origin.y)];
      double scale = std::min(w / extent.size.width, h / extent.size.height);
      video = [video imageByApplyingTransform:CGAffineTransformMakeScale(scale, scale)];
      video = [video imageByApplyingTransform:CGAffineTransformMakeTranslation((w - extent.size.width * scale) / 2, (h - extent.size.height * scale) / 2)];
      image = [video imageByCompositingOverImage:image];
    }
    [context render:image toCVPixelBuffer:pixels bounds:bounds colorSpace:colorSpace];
    return pixels;
  }
};

class Deck: public std::enable_shared_from_this<Deck> {
  int index;
  Ndi &ndi;
  void *sender;
  Settings settings;
  bool sourceFormat;
  std::mutex mutex;
  std::condition_variable condition;
  State pending;
  std::unique_ptr<Loaded> loaded;
  std::thread thread;
  bool stop = false;
  uint64_t loadToken = 0;
  std::string reported;
  NSDictionary *__strong lastFrame = nil;
  size_t frameCount = 0;
public:
  Deck(int index, Ndi &ndi, const std::string &name, Settings settings, bool sourceFormat):
    index(index), ndi(ndi), sender(ndi.sender(name)), settings(settings), sourceFormat(sourceFormat) {}
  ~Deck() { close(); }
  void start() { thread = std::thread([this] { run(); }); }
  void update(State state) { std::lock_guard<std::mutex> guard(mutex); pending = std::move(state); condition.notify_one(); }
  void close() {
    { std::lock_guard<std::mutex> guard(mutex); stop = true; condition.notify_all(); }
    if (thread.joinable()) thread.join();
    // A cancelled metadata callback can briefly retain Deck after the runtime closes.
    if (sender) { ndi.closeSender(sender); sender = nullptr; }
  }
  void inspect(id identifier) {
    std::lock_guard<std::mutex> guard(mutex);
    emit(@{@"type":@"inspection", @"id":identifier, @"deck":@(index), @"frame":lastFrame ?: (id)NSNull.null});
  }
  void status(const State &state, const char *value, int width, int height, double fps, const std::string &error = {}) {
    std::string signature = state.generation + ":" + value + ":" + error + ":" + std::to_string(width) + ":" + std::to_string(height) + ":" + std::to_string(fps);
    if (signature == reported) return; reported = signature;
    NSMutableDictionary *message = [@{@"type":@"status", @"deck":@(index), @"generation":ns(state.generation), @"state":@(value), @"width":@(width), @"height":@(height), @"fps":@(fps)} mutableCopy];
    if (!error.empty()) message[@"error"] = ns(error);
    emit(message);
  }
  void run() {
    @autoreleasepool {
      State state;
      std::string generation, path, failure;
      AVURLAsset *__strong asset = nil;
      std::unique_ptr<Decoder> decoder;
      Canvas canvas;
      double loadStarted = 0, nextFrameAt = 0;
      bool scheduledActive = false;
      while (!stopping) {
        @autoreleasepool {
          std::unique_ptr<Loaded> result;
          bool controlChanged = false;
          {
            std::unique_lock<std::mutex> guard(mutex);
            double wait = std::max(0.0, nextFrameAt - hostNow());
            if (wait > 0) condition.wait_for(guard, std::chrono::duration<double>(std::min(wait, settings.stateTimeoutSec)));
            if (stop) break;
            double receivedNow = hostNow();
            controlChanged = state.playing != pending.playing || state.rate != pending.rate ||
              std::abs(projected(state, receivedNow) - projected(pending, receivedNow)) > settings.seekThresholdSec;
            state = pending;
            result = std::move(loaded);
          }
          double now = hostNow();
          if (controlChanged) nextFrameAt = now;
          if (state.generation != generation || state.path != path) {
            [asset cancelLoading]; asset = nil; decoder.reset(); failure.clear(); result.reset();
            generation = state.generation; path = state.path; nextFrameAt = now;
            uint64_t token;
            { std::lock_guard<std::mutex> guard(mutex); token = ++loadToken; loaded.reset(); }
            if (!path.empty()) {
              asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:ns(path)] options:@{AVURLAssetPreferPreciseDurationAndTimingKey:@YES}];
              loadStarted = now;
              std::weak_ptr<Deck> weak = shared_from_this();
              loadVideo(asset, [weak, token](Loaded value) {
                if (auto self = weak.lock()) {
                  std::lock_guard<std::mutex> guard(self->mutex);
                  if (!self->stop && self->loadToken == token) { self->loaded = std::make_unique<Loaded>(std::move(value)); self->condition.notify_one(); }
                }
              });
            }
          }
          if (result && failure.empty()) {
            failure = result->error;
            if (failure.empty() && (result->bounds.size.width > settings.maxFramePixels || result->bounds.size.height > settings.maxFramePixels ||
                result->bounds.size.width * result->bounds.size.height > settings.maxFramePixels ||
                result->track.naturalSize.width * result->track.naturalSize.height > settings.maxFramePixels)) failure = "Video exceeds configured frame pixel limit";
            if (failure.empty()) decoder = std::make_unique<Decoder>(std::move(*result));
          }
          if (asset && !decoder && failure.empty() && now - loadStarted > settings.loadTimeoutSec) {
            [asset cancelLoading]; failure = "Video loading timed out";
          }
          int width = 1920, height = 1080;
          double fps = 30;
          bool active = decoder && failure.empty() && state.playing && now - state.hostTime <= settings.stateTimeoutSec && now - state.receivedAt <= settings.stateTimeoutSec;
          double target = projected(state, now);
          active = active && target >= decoder->source.start && target < decoder->source.duration;
          if (active != scheduledActive) nextFrameAt = now;
          if (now + settings.timerLeewaySec < nextFrameAt) continue;
          scheduledActive = active;
          if (decoder && sourceFormat && failure.empty()) {
            double desiredFps = decoder->source.fps * state.rate;
            if (desiredFps > 0 && desiredFps <= settings.maxOutputFps) {
              width = int(std::ceil(decoder->source.bounds.size.width));
              width += width % 2;
              height = int(std::ceil(decoder->source.bounds.size.height));
              fps = active ? desiredFps : std::min(decoder->source.fps, settings.maxOutputFps);
            }
          }
          try {
            if (double(width) * height > settings.maxFramePixels) throw std::runtime_error("Output exceeds configured frame pixel limit");
            CVPixelBufferRef frame = active ? decoder->frame(target, settings) : nullptr;
            CVPixelBufferRef rendered = canvas.render(frame, frame ? &decoder->source : nullptr, width, height);
            ndi.send(sender, rendered, frameRate(fps));
            if (ndi.test) {
              CVPixelBufferLockBaseAddress(rendered, kCVPixelBufferLock_ReadOnly);
              const uint8_t *center = static_cast<const uint8_t *>(CVPixelBufferGetBaseAddress(rendered)) + CVPixelBufferGetBytesPerRow(rendered) * (height / 2) + (width / 2) * 4;
              NSDictionary *details = @{@"generation":ns(state.generation), @"black":@(frame == nullptr), @"width":@(width), @"height":@(height), @"fps":@(fps),
                @"framePositionSec":frame ? @(decoder->position()) : (id)NSNull.null, @"seeks":@(decoder ? decoder->seeks : 0), @"count":@(++frameCount),
                @"centerBgra":@[@(center[0]), @(center[1]), @(center[2]), @(center[3])]};
              CVPixelBufferUnlockBaseAddress(rendered, kCVPixelBufferLock_ReadOnly);
              std::lock_guard<std::mutex> guard(mutex); lastFrame = details;
            }
            const char *label = !failure.empty() ? "error" : asset && !decoder ? "loading" : active && frame ? "playing" : "idle";
            status(state, label, width, height, fps, failure);
          } catch (const std::exception &error) {
            failure = error.what(); decoder.reset();
            status(state, "error", width, height, fps, failure);
          }
          double period = 1 / fps;
          nextFrameAt = std::max(nextFrameAt + period, hostNow());
        }
      }
      [asset cancelLoading];
      decoder.reset();
    }
  }
};

Settings probeSettings() { return {1, 15, .25, 33177600, 240, 512, 0}; }
struct ProbeLoad { std::mutex mutex; std::condition_variable condition; std::unique_ptr<Loaded> value; };
int probe(const char *file, double position) {
  auto pending = std::make_shared<ProbeLoad>();
  AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:@(file)] options:@{AVURLAssetPreferPreciseDurationAndTimingKey:@YES}];
  loadVideo(asset, [pending](Loaded result) { std::lock_guard<std::mutex> guard(pending->mutex); pending->value = std::make_unique<Loaded>(std::move(result)); pending->condition.notify_one(); });
  std::unique_lock<std::mutex> guard(pending->mutex);
  if (!pending->condition.wait_for(guard, std::chrono::duration<double>(probeSettings().loadTimeoutSec), [&] { return bool(pending->value); })) {
    [asset cancelLoading]; throw std::runtime_error("Probe load timed out");
  }
  if (!pending->value->error.empty()) throw std::runtime_error(pending->value->error);
  Decoder decoder(std::move(*pending->value));
  if (position < decoder.source.start || position >= decoder.source.duration) throw std::runtime_error("Probe position outside video duration");
  CVPixelBufferRef image = decoder.frame(position, probeSettings());
  if (!image) throw std::runtime_error("Probe did not decode a video frame");
  Canvas canvas;
  CVPixelBufferRef rendered = canvas.render(image, &decoder.source, 1920, 1080);
  CVPixelBufferLockBaseAddress(rendered, kCVPixelBufferLock_ReadOnly);
  const uint8_t *center = static_cast<const uint8_t *>(CVPixelBufferGetBaseAddress(rendered)) + CVPixelBufferGetBytesPerRow(rendered) * 540 + 960 * 4;
  const uint8_t *corner = static_cast<const uint8_t *>(CVPixelBufferGetBaseAddress(rendered));
  emit(@{@"type":@"probe", @"width":@(decoder.source.bounds.size.width), @"height":@(decoder.source.bounds.size.height), @"fps":@(decoder.source.fps), @"durationSec":@(decoder.source.duration), @"framePositionSec":@(decoder.position()), @"centerBgra":@[@(center[0]),@(center[1]),@(center[2]),@(center[3])], @"cornerBgra":@[@(corner[0]),@(corner[1]),@(corner[2]),@(corner[3])], @"ndiInitialized":@NO});
  CVPixelBufferUnlockBaseAddress(rendered, kCVPixelBufferLock_ReadOnly);
  return 0;
}
int selfTest() {
  State state; state.position = 10; state.rate = 1.04; state.hostTime = 100; state.playing = true;
  if (std::abs(projected(state, 102) - 12.08) > 1e-9) throw std::runtime_error("Position projection failed");
  state.playing = false;
  if (projected(state, 102) != 10) throw std::runtime_error("Pause projection failed");
  FrameRate rate = frameRate(30 * 1.04);
  if (std::abs(rate.value() - 31.2) > 1e-9) throw std::runtime_error("Pitch-adjusted frame rate failed");
  if (std::abs(frameRate(30000.0 / 1001).value() - 30000.0 / 1001) > 1e-6) throw std::runtime_error("Fractional frame rate failed");
  Canvas canvas;
  CVPixelBufferRef black = canvas.render(nullptr, nullptr, 1920, 1080);
  CVPixelBufferLockBaseAddress(black, kCVPixelBufferLock_ReadOnly);
  auto bytes = static_cast<const uint8_t *>(CVPixelBufferGetBaseAddress(black));
  bool correct = bytes[0] == 0 && bytes[1] == 0 && bytes[2] == 0 && bytes[3] == 255;
  CVPixelBufferUnlockBaseAddress(black, kCVPixelBufferLock_ReadOnly);
  if (!correct) throw std::runtime_error("Opaque black frame failed");
  emit(@{@"type":@"self_test", @"ok":@YES, @"ndiInitialized":@NO});
  return 0;
}
bool readLine(std::string &line) {
  line.clear();
  char c;
  while (std::cin.get(c)) {
    if (c == '\n') return true;
    if (line.size() == protocolLineLimit) throw std::runtime_error("Protocol line exceeds 64 KiB");
    line.push_back(c);
  }
  return !line.empty();
}
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    signal(SIGPIPE, SIG_IGN);
    try {
      if (argc == 2 && std::string(argv[1]) == "--self-test") return selfTest();
      if (argc >= 3 && std::string(argv[1]) == "--probe") return probe(argv[2], argc > 3 ? std::stod(argv[3]) : 0);
      bool testMode = argc == 2 && std::string(argv[1]) == "--test-mode";
      if (argc > 1 && !testMode) throw std::runtime_error("Unknown helper argument");
      struct Outputs {
        std::unique_ptr<Ndi> ndi;
        std::vector<std::shared_ptr<Deck>> decks;
        ~Outputs() { for (auto &deck : decks) deck->close(); }
      } outputs;
      auto &ndi = outputs.ndi;
      auto &decks = outputs.decks;
      int64_t sequence = -1;
      emit(@{@"type":@"ready", @"protocol":@1, @"testMode":@(testMode), @"ndiAvailable":@(bool(SLWV_NDI_AVAILABLE))});
      std::string line;
      while (readLine(line)) {
        @autoreleasepool {
          NSData *data = [NSData dataWithBytes:line.data() length:line.size()];
          NSError *error = nil;
          id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
          if (![value isKindOfClass:NSDictionary.class]) throw std::runtime_error("Invalid JSON protocol message");
          NSDictionary *message = value;
          std::string type = stringValue(message, @"type");
          if (type == "ping") {
            id ident = message[@"id"];
            if (![ident isKindOfClass:NSNumber.class] && ![ident isKindOfClass:NSString.class]) invalid("ping id");
            emit(@{@"type":@"pong", @"id":ident, @"hostTimeSec":@(hostNow())});
          } else if (type == "inspect" && testMode) {
            id ident = message[@"id"];
            if (![ident isKindOfClass:NSNumber.class] && ![ident isKindOfClass:NSString.class]) invalid("inspection id");
            for (auto &deck : decks) deck->inspect(ident);
          } else if (type == "shutdown") break;
          else if (type == "configure") {
            if (number(message, @"protocol") != 1) invalid("protocol version");
            Settings settings = settingsFrom(message[@"settings"]);
            std::string format = stringValue(message, @"outputFormat");
            if (format != "source" && format != "1080p30") invalid("outputFormat");
            NSArray *names = message[@"sourceNames"];
            if (![names isKindOfClass:NSArray.class] || names.count != 4) invalid("sourceNames");
            for (id name in names) if (![name isKindOfClass:NSString.class] || [name length] == 0) invalid("source name");
            for (auto &deck : decks) deck->close();
            decks.clear();
            if (!ndi) ndi = std::make_unique<Ndi>(testMode);
            for (int i = 0; i < 4; i++) decks.push_back(std::make_shared<Deck>(i + 1, *ndi, utf8(names[i]), settings, format == "source"));
            for (auto &deck : decks) deck->start();
            emit(@{@"type":@"configured", @"protocol":@1});
          } else if (type == "state") {
            if (decks.size() != 4) throw std::runtime_error("State received before configure");
            double seq = number(message, @"seq");
            if (seq < 0 || seq != std::floor(seq) || seq > 9007199254740991.0) invalid("seq");
            if (seq <= sequence) continue;
            double clock = number(message, @"hostTimeSec");
            NSArray *updates = message[@"decks"];
            if (![updates isKindOfClass:NSArray.class] || updates.count != 4) invalid("decks");
            std::vector<State> states(4); bool seen[4] = {};
            for (id raw in updates) {
              if (![raw isKindOfClass:NSDictionary.class]) invalid("deck state");
              NSDictionary *update = raw;
              double deckNumber = number(update, @"deck");
              if (deckNumber < 1 || deckNumber > 4 || deckNumber != std::floor(deckNumber)) invalid("deck number");
              int index = int(deckNumber) - 1;
              if (seen[index]) invalid("duplicate deck"); seen[index] = true;
              State state;
              state.generation = stringValue(update, @"generation");
              if (update[@"path"] != NSNull.null) state.path = stringValue(update, @"path");
              if (!state.path.empty() && state.path[0] != '/') invalid("absolute video path");
              state.position = number(update, @"positionSec");
              state.rate = positive(update, @"rate");
              state.playing = boolean(update, @"playing");
              state.hostTime = clock; state.receivedAt = hostNow();
              states[index] = std::move(state);
            }
            sequence = int64_t(seq);
            for (int i = 0; i < 4; i++) decks[i]->update(std::move(states[i]));
          } else throw std::runtime_error("Unknown protocol message: " + type);
        }
      }
      return 0;
    } catch (const std::exception &error) {
      stopping = true;
      emit(@{@"type":@"error", @"error":ns(error.what())});
      return 1;
    }
  }
}
