# LayerFS Sandbox runtime (node24) plus a pinned Rust toolchain for the Rust dsh demo.
FROM layerfs-352-runtime:node24
ENV RUSTUP_HOME=/opt/rustup PATH=/opt/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh \
 && CARGO_HOME=/opt/cargo sh /tmp/rustup-init.sh -y --no-modify-path --profile minimal --default-toolchain 1.85.1 -c clippy -c rustfmt \
 && rm /tmp/rustup-init.sh && chmod -R a+rX /opt/rustup /opt/cargo \
 && rustc --version && cargo --version
