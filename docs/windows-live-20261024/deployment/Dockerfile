# Local verification deployment only; the source image is recorded in receipts.
FROM layerfs-428-verification:scenarios
ENV HTTPS_PROXY=http://172.17.0.1:15237 \
    https_proxy=http://172.17.0.1:15237 \
    NO_PROXY=localhost,127.0.0.1,::1 \
    no_proxy=localhost,127.0.0.1,::1
