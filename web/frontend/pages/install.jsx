import {
    Page, Layout, MediaCard, VideoThumbnail, Button, Modal, Icon,
    Card, TextContainer, Stack
} from "@shopify/polaris";
import { useState, useCallback } from 'react';
import {
    HomeMajor, ChecklistMajor
} from '@shopify/polaris-icons';
import { useNavigate } from "react-router-dom";
import CodeSnippetWithCopy from "../components/CodeSnippetWithCopy";


export default function Installation() {
    const [active, setActive] = useState(false);

    const handleChange = useCallback(() => setActive(!active), [active]);

    const navigate = useNavigate();

    const gotoHomePage = () => {
        navigate("/");
    }

    const gotoInstallPage = () => {
        navigate("/install");

    }

    return (
        <Page title="Installation">
            <Layout>
                <Layout.Section>
                    <Card sectioned>
                        <Stack alignment="center" distribution="equalSpacing">
                            <Button onClick={gotoHomePage} icon={HomeMajor}>
                                Home
                            </Button>
                            <Button primary onClick={gotoInstallPage} icon={ChecklistMajor}>
                                Installation
                            </Button>
                        </Stack>
                    </Card>
                </Layout.Section>

                <Layout.Section oneHalf>
                    <MediaCard
                        title="Quick setup"
                        primaryAction={{
                            content: 'Installation Steps',
                            onAction: () => { handleChange() },
                        }}
                        description="Set up PromoLoom in your theme, then configure your product page offers."
                    >
                        <VideoThumbnail
                            videoLength={120}
                            thumbnailUrl="https://cdn.shopify.com/s/files/1/0024/0084/5893/files/Copy_of_hanloy_2.gif"
                            onClick={handleChange}
                        />
                    </MediaCard>
                </Layout.Section>

                <Layout.Section oneHalf>
                    <Card sectioned>
                        <TextContainer spacing="loose">
                            <h2>What you will do</h2>
                            <p>Open the quick setup video, add the PromoLoom block to your product template, and then configure your coupon copy.</p>
                        </TextContainer>
                    </Card>
                </Layout.Section>

                <Layout.Section>
                    <CodeSnippetWithCopy/>
                </Layout.Section>

                <Modal
                    open={active}
                    onClose={handleChange}
                    title="Quick Setup in 2.0 themes"
                    accessibilityLabel="Quick setup video"
                >
                    <Modal.Section>
                        <div style={{ padding: '56% 0 0 0', position: 'relative' }}><iframe src="https://cdn.shopify.com/videos/c/o/v/879c7b0f313e4e858abc5c16733670d3.mp4?portrait=0&loop=1&title=0&byline=0&sidedock=0&h=881b23983c&amp;badge=0&amp;autopause=0&amp;player_id=0&amp;app_id=58479&amp;autoplay=1" frameBorder="0" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen style={{ position: 'absolute', top: '0', left: '0', width: '100%', height: '100%' }} title="Quick Setup"></iframe></div>
                    </Modal.Section>
                </Modal>
            </Layout>
        </Page>
    );
}


