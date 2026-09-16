{ config, lib, pkgs, ... }:

let
  cfg = config.services.feedbackService;
  inherit (lib) mkDefault mkEnableOption mkIf mkOption types;
in
{
  options.services.feedbackService = {
    enable = mkEnableOption "GitHub-backed feedback service";

    repositoryDirectory = mkOption {
      type = types.str;
      default = "/srv/feedback";
    };

    port = mkOption {
      type = types.port;
      default = 18080;
    };

    forwardedAllowIps = mkOption {
      type = types.str;
      default = "172.17.0.1";
      description = "Addresses trusted to supply forwarded headers to Uvicorn.";
    };

    proxy = {
      enable = mkEnableOption "the feedback nginx virtual host" // { default = true; };

      hostName = mkOption {
        type = types.str;
        example = "feedback-api.example.com";
      };

      enableACME = mkOption {
        type = types.bool;
        default = true;
      };
    };
  };

  config = mkIf cfg.enable {
    virtualisation.docker.enable = mkDefault true;

    systemd.services.feedback-service = {
      description = "GitHub-backed feedback service";
      after = [ "docker.service" "network-online.target" ];
      requires = [ "docker.service" ];
      wants = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];
      environment = {
        FEEDBACK_FORWARDED_ALLOW_IPS = cfg.forwardedAllowIps;
        FEEDBACK_HOST_PORT = toString cfg.port;
      };
      unitConfig.ConditionPathExists = "${cfg.repositoryDirectory}/compose.deploy.yaml";
      serviceConfig = {
        Type = "simple";
        WorkingDirectory = cfg.repositoryDirectory;
        ExecStartPre = [
          "${pkgs.coreutils}/bin/test -s config/sites.toml"
          "${pkgs.coreutils}/bin/test -s config/secrets/github-app-private-key.pem"
          "${pkgs.coreutils}/bin/test -s config/secrets/github-client-secret"
          "${pkgs.coreutils}/bin/test -s config/secrets/oauth-state-hmac-key"
        ];
        ExecStart = "${pkgs.docker-compose}/bin/docker-compose -f compose.deploy.yaml up --build --remove-orphans";
        ExecStop = "${pkgs.docker-compose}/bin/docker-compose -f compose.deploy.yaml down";
        Restart = "on-failure";
        RestartSec = 5;
        TimeoutStartSec = 0;
        TimeoutStopSec = 30;
      };
    };

    services.nginx = mkIf cfg.proxy.enable {
      enable = mkDefault true;
      recommendedGzipSettings = mkDefault true;
      recommendedProxySettings = mkDefault true;
      appendHttpConfig = ''
        limit_req_zone $binary_remote_addr zone=feedback_general:10m rate=10r/s;
        limit_req_zone $binary_remote_addr zone=feedback_sensitive:10m rate=10r/m;
        limit_req_status 429;
      '';
      virtualHosts.${cfg.proxy.hostName} = {
        enableACME = cfg.proxy.enableACME;
        forceSSL = cfg.proxy.enableACME;
        extraConfig = ''
          client_max_body_size 16k;
          client_body_timeout 5s;
        '';
        locations = {
          "~ ^/v1/sites/[a-z0-9-]+/(?:oauth/(?:authorize|exchange)|discussions/ensure)$" = {
            proxyPass = "http://127.0.0.1:${toString cfg.port}";
            extraConfig = ''
              limit_req zone=feedback_sensitive burst=5 nodelay;
              proxy_connect_timeout 3s;
              proxy_read_timeout 15s;
              proxy_send_timeout 15s;
            '';
          };
          "/" = {
            proxyPass = "http://127.0.0.1:${toString cfg.port}";
            extraConfig = ''
              limit_req zone=feedback_general burst=30 nodelay;
              proxy_connect_timeout 3s;
              proxy_read_timeout 15s;
              proxy_send_timeout 15s;
            '';
          };
        };
      };
    };

    networking.firewall.allowedTCPPorts = mkIf cfg.proxy.enable [ 80 443 ];
  };
}
