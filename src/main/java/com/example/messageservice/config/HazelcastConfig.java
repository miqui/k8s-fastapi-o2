package com.example.messageservice.config;

import com.hazelcast.client.HazelcastClient;
import com.hazelcast.client.config.ClientConfig;
import com.hazelcast.core.HazelcastInstance;
import com.hazelcast.spring.cache.HazelcastCacheManager;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cache.CacheManager;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;

/**
 * The app connects as a Hazelcast *client* to a standalone Hazelcast member deployed on
 * its own node (see k8s/hazelcast-deployment.yaml), rather than embedding a member in each
 * pod - that keeps the cache tier independent of app pod restarts/scaling. Unisocket mode is
 * used since there's a single member behind a plain ClusterIP Service; smart routing (talking
 * to every member directly) would need per-pod addressing instead.
 *
 * Deliberately no client-side Near Cache: verified in a multi-pod deployment that a Near Cache
 * on this map goes stale across pods after @CacheEvict (update/delete) - the invalidation
 * broadcast the client SDK is supposed to send other clients' near-caches wasn't reliably
 * reaching them, so a pod other than the one that wrote the update kept serving old data
 * indefinitely. Reads go straight to the shared Hazelcast member instead, which stays correct.
 *
 * Excluded from the "test" profile: tests run with no Hazelcast server available, and this
 * bean would otherwise block/fail trying to connect one. See TestCacheConfig for its replacement.
 */
@Configuration
@Profile("!test")
public class HazelcastConfig {

    @Bean(destroyMethod = "shutdown")
    public HazelcastInstance hazelcastInstance(
            @Value("${HAZELCAST_HOST:localhost}") String host,
            @Value("${HAZELCAST_PORT:5701}") String port) {
        ClientConfig clientConfig = new ClientConfig();
        clientConfig.setClusterName("message-service-cache");
        clientConfig.getNetworkConfig()
                .addAddress(host + ":" + port)
                .setSmartRouting(false);
        return HazelcastClient.newHazelcastClient(clientConfig);
    }

    @Bean
    public CacheManager cacheManager(HazelcastInstance hazelcastInstance) {
        return new HazelcastCacheManager(hazelcastInstance);
    }
}
