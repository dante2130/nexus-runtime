#include <gst/gst.h>
#include <stdio.h>

/* Probe only the pinned runtime plugin directory, not host GStreamer. */
int main(int argc, char **argv)
{
    GstRegistry *registry;
    static const char *required[] = {
        "avdec_h264", "avdec_aac", "asfdemux", "avdec_wmv3", "avdec_wmapro",
        "theoradec", "vp8dec", "vp9dec", "oggdemux", "vorbisdec", "mpg123audiodec", "hlsdemux"
    };
    unsigned int i;

    if (argc != 2 && argc != 3) return 2;
    gst_init(&argc, &argv);
    registry = gst_registry_get();
    gst_registry_scan_path(registry, argv[1]);
    /* A decoder alone cannot open an ASF file. Require both its container
     * handler and the WMV/WMA decoder factories from the bundled plugins. */
    for (i = 0; i < G_N_ELEMENTS(required); ++i) {
        GstElementFactory *factory = gst_element_factory_find(required[i]);
        if (!factory) {
            fprintf(stderr, "Runtime is missing media component %s.\n", required[i]);
            return 1;
        }
        gst_object_unref(factory);
    }
    puts("Runtime H.264, AAC, ASF, WMV3 and WMA Pro GStreamer components are available.");
    if (argc == 3) {
        GstElement *player = gst_element_factory_make("playbin", NULL);
        GstElement *video_sink = gst_element_factory_make("fakesink", NULL);
        GstElement *audio_sink = gst_element_factory_make("fakesink", NULL);
        GstBus *bus;
        GstMessage *message;
        char *uri = g_filename_to_uri(argv[2], NULL, NULL);
        int result = 0;
        if (!player || !video_sink || !audio_sink || !uri) return 1;
        g_object_set(player, "uri", uri, "video-sink", video_sink,
                     "audio-sink", audio_sink, NULL);
        g_free(uri);
        bus = gst_element_get_bus(player);
        gst_element_set_state(player, GST_STATE_PLAYING);
        message = gst_bus_timed_pop_filtered(bus, 120 * GST_SECOND,
                                             GST_MESSAGE_EOS | GST_MESSAGE_ERROR);
        if (!message || GST_MESSAGE_TYPE(message) != GST_MESSAGE_EOS) {
            if (message && GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
                GError *error = NULL;
                gst_message_parse_error(message, &error, NULL);
                fprintf(stderr, "Media decode failed: %s\n", error->message);
                g_error_free(error);
            } else fprintf(stderr, "Media decode timed out.\n");
            result = 1;
        }
        if (message) gst_message_unref(message);
        gst_element_set_state(player, GST_STATE_NULL);
        gst_object_unref(bus);
        gst_object_unref(player);
        if (result) return result;
        puts("Runtime decoded the supplied media through GStreamer.");
    }
    return 0;
}
